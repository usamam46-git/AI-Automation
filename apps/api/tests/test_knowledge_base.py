"""
tests/test_knowledge_base.py — /api/v1/knowledge-bases.

Integration tests against the real test database. The cross-tenant chunk test is
the one the 15-day plan calls out by name: `document_chunks` has no
`organization_id` and is not in the RLS policy set, so the join through
`documents` in the repository is the ONLY thing standing between one tenant and
another's indexed content.
"""

import io
import uuid

import pytest
from httpx import AsyncClient

PDF_MIME = "application/pdf"


def _pdf(lines: list[str]) -> bytes:
    """Minimal text-extractable PDF; mirrors the helper in test_document_text."""

    def esc(s: str) -> str:
        return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")

    content = ["BT", "/F1 11 Tf", "56 760 Td", "14 TL"] + [f"({esc(x)}) Tj T*" for x in lines] + ["ET"]
    stream = "\n".join(content).encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(out.tell())
        out.write(f"{i} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objs) + 1}\n".encode())
    out.write(b"0000000000 65535 f \n")
    for off in offsets:
        out.write(f"{off:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


async def _tenant(client: AsyncClient, slug: str) -> tuple[dict, str]:
    """Register an org and give it a workspace. Returns (headers, workspace_id)."""
    from test_workflow_versions import register_and_get_token
    from test_workflows import create_workspace

    data = await register_and_get_token(client, f"{slug}-{uuid.uuid4().hex[:6]}")
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    workspace = await create_workspace(client, data["access_token"])
    return headers, workspace["id"]


async def _create_kb(client: AsyncClient, headers: dict, workspace_id: str, **overrides) -> dict:
    payload = {"workspace_id": workspace_id, "name": "AP Policy", **overrides}
    response = await client.post("/api/v1/knowledge-bases", json=payload, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


# ---------------------------------------------------------------------------
# Knowledge bases
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_defaults_to_the_cheap_embedding_model(client: AsyncClient):
    """
    The API default is -small, NOT the column default (-large).

    Both are requested at 1536 dimensions, so they are interchangeable in the
    schema; -small is 6.5x cheaper and the development loop re-indexes the same
    corpus repeatedly.
    """
    headers, workspace_id = await _tenant(client, "kb")
    kb = await _create_kb(client, headers, workspace_id)
    assert kb["embedding_model"] == "text-embedding-3-small"
    assert kb["workspace_id"] == workspace_id


@pytest.mark.asyncio
async def test_an_unknown_embedding_model_is_rejected_at_create(client: AsyncClient):
    """
    `embedding_spec_for()` fails closed, so a free-text model would create a KB
    that raises on its first ingestion rather than at the typo.
    """
    headers, workspace_id = await _tenant(client, "kb")
    response = await client.post(
        "/api/v1/knowledge-bases",
        json={"workspace_id": workspace_id, "name": "Bad", "embedding_model": "text-embedding-9-enormous"},
        headers=headers,
    )
    assert response.status_code == 422
    assert "not a supported embedding model" in response.text


@pytest.mark.asyncio
async def test_organization_id_cannot_be_set_by_the_client(client: AsyncClient):
    """Tenant scope comes from the token. A client-settable one is a bug."""
    headers, workspace_id = await _tenant(client, "kb")
    other = uuid.uuid4()
    kb = await _create_kb(client, headers, workspace_id, organization_id=str(other))
    assert kb["organization_id"] != str(other)


@pytest.mark.asyncio
async def test_embedding_model_is_immutable(client: AsyncClient):
    """
    Changing it would invalidate every chunk already stored — cosine similarity
    across two embedding spaces returns plausible numbers and meaningless
    rankings, with nothing raising. `extra="forbid"` makes it a 422, not a
    silent no-op.
    """
    headers, workspace_id = await _tenant(client, "kb")
    kb = await _create_kb(client, headers, workspace_id)

    rejected = await client.patch(
        f"/api/v1/knowledge-bases/{kb['id']}",
        json={"embedding_model": "text-embedding-3-large"},
        headers=headers,
    )
    assert rejected.status_code == 422

    renamed = await client.patch(f"/api/v1/knowledge-bases/{kb['id']}", json={"name": "Renamed"}, headers=headers)
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Renamed"
    assert renamed.json()["embedding_model"] == kb["embedding_model"]


@pytest.mark.asyncio
async def test_a_workspace_from_another_org_is_not_found(client: AsyncClient):
    headers_a, _ = await _tenant(client, "orga")
    _, workspace_b = await _tenant(client, "orgb")

    response = await client.post(
        "/api/v1/knowledge-bases",
        json={"workspace_id": workspace_b, "name": "Sneaky"},
        headers=headers_a,
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_knowledge_bases_are_isolated_between_orgs(client: AsyncClient):
    headers_a, workspace_a = await _tenant(client, "orga")
    headers_b, workspace_b = await _tenant(client, "orgb")

    kb_a = await _create_kb(client, headers_a, workspace_a, name="A's policies")
    await _create_kb(client, headers_b, workspace_b, name="B's policies")

    # 404, never 403 — a 403 confirms the resource exists.
    assert (await client.get(f"/api/v1/knowledge-bases/{kb_a['id']}", headers=headers_b)).status_code == 404

    listed = await client.get("/api/v1/knowledge-bases", headers=headers_b)
    assert [kb["name"] for kb in listed.json()] == ["B's policies"]


# ---------------------------------------------------------------------------
# Uploads
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upload_accepts_a_pdf_and_queues_ingestion(client: AsyncClient, celery_calls):
    headers, workspace_id = await _tenant(client, "kb")
    kb = await _create_kb(client, headers, workspace_id)

    response = await client.post(
        f"/api/v1/knowledge-bases/{kb['id']}/documents",
        files={"file": ("ap-policy.pdf", _pdf(["Invoices above USD 5,000 need approval."]), PDF_MIME)},
        headers=headers,
    )
    # 202: the row exists but the document is not usable until the worker runs.
    assert response.status_code == 202, response.text
    document = response.json()
    assert document["status"] == "uploaded"
    assert document["mime_type"] == PDF_MIME
    assert document["content_hash"] is None
    assert document["error"] is None

    dispatched = [name for name, _, _ in celery_calls]
    assert dispatched == ["ingest_document"], "the upload must enqueue exactly one ingestion"


@pytest.mark.asyncio
async def test_unsupported_file_types_are_refused_with_415(client: AsyncClient, celery_calls):
    headers, workspace_id = await _tenant(client, "kb")
    kb = await _create_kb(client, headers, workspace_id)

    response = await client.post(
        f"/api/v1/knowledge-bases/{kb['id']}/documents",
        files={"file": ("scan.png", b"\x89PNG\r\n\x1a\n", "image/png")},
        headers=headers,
    )
    assert response.status_code == 415
    assert celery_calls == [], "a rejected upload must not queue work"


@pytest.mark.asyncio
async def test_an_empty_file_is_refused(client: AsyncClient):
    headers, workspace_id = await _tenant(client, "kb")
    kb = await _create_kb(client, headers, workspace_id)

    response = await client.post(
        f"/api/v1/knowledge-bases/{kb['id']}/documents",
        files={"file": ("empty.txt", b"", "text/plain")},
        headers=headers,
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_oversized_uploads_are_refused_with_413(client: AsyncClient, celery_calls):
    """A size cap is a cost bound: chunk count scales with bytes, and so does the
    embedding bill."""
    from src.modules.knowledge_base.service import MAX_UPLOAD_BYTES

    headers, workspace_id = await _tenant(client, "kb")
    kb = await _create_kb(client, headers, workspace_id)

    response = await client.post(
        f"/api/v1/knowledge-bases/{kb['id']}/documents",
        files={"file": ("huge.txt", b"x" * (MAX_UPLOAD_BYTES + 1), "text/plain")},
        headers=headers,
    )
    assert response.status_code == 413
    assert celery_calls == []


@pytest.mark.asyncio
async def test_uploading_into_another_orgs_kb_is_not_found(client: AsyncClient, celery_calls):
    headers_a, workspace_a = await _tenant(client, "orga")
    headers_b, _ = await _tenant(client, "orgb")
    kb_a = await _create_kb(client, headers_a, workspace_a)

    response = await client.post(
        f"/api/v1/knowledge-bases/{kb_a['id']}/documents",
        files={"file": ("x.txt", b"content", "text/plain")},
        headers=headers_b,
    )
    assert response.status_code == 404
    assert celery_calls == []


# ---------------------------------------------------------------------------
# Chunks — the table with no tenant column
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chunks_are_isolated_between_orgs(client: AsyncClient, session):
    """
    The isolation test the plan calls out by name.

    `document_chunks` has no `organization_id` and is absent from the RLS policy
    set, because there is nothing for a policy to filter on. The join through
    `documents` in `KnowledgeBaseRepository.list_chunks` is the only defence, and
    dropping it would be a silent cross-tenant read of indexed policy text.
    """
    from src.modules.knowledge_base.models import DocumentChunk

    headers_a, workspace_a = await _tenant(client, "orga")
    headers_b, _ = await _tenant(client, "orgb")
    kb_a = await _create_kb(client, headers_a, workspace_a)

    upload = await client.post(
        f"/api/v1/knowledge-bases/{kb_a['id']}/documents",
        files={"file": ("secret.txt", b"Org A confidential approval limits.", "text/plain")},
        headers=headers_a,
    )
    document_id = upload.json()["id"]

    # Chunks are normally written by the worker; insert one directly so the read
    # path is exercised without running an embedding.
    session.add(
        DocumentChunk(
            document_id=uuid.UUID(document_id),
            chunk_index=0,
            content="Org A confidential approval limits.",
            embedding=[0.0] * 1536,
            token_count=7,
        )
    )
    await session.commit()

    owner = await client.get(f"/api/v1/knowledge-bases/{kb_a['id']}/documents/{document_id}/chunks", headers=headers_a)
    assert owner.status_code == 200
    assert len(owner.json()) == 1
    assert "confidential" in owner.json()[0]["content"]

    intruder = await client.get(f"/api/v1/knowledge-bases/{kb_a['id']}/documents/{document_id}/chunks", headers=headers_b)
    assert intruder.status_code == 404
    assert "confidential" not in intruder.text


@pytest.mark.asyncio
async def test_chunk_responses_never_carry_the_embedding(client: AsyncClient, session):
    """
    1536 floats per chunk would make a page of chunks a multi-megabyte payload
    of data no client can use — the vector's only consumer is the cosine query
    inside Postgres.
    """
    from src.modules.knowledge_base.models import DocumentChunk

    headers, workspace_id = await _tenant(client, "kb")
    kb = await _create_kb(client, headers, workspace_id)
    upload = await client.post(
        f"/api/v1/knowledge-bases/{kb['id']}/documents",
        files={"file": ("a.txt", b"Some indexed content.", "text/plain")},
        headers=headers,
    )
    document_id = upload.json()["id"]

    session.add(
        DocumentChunk(
            document_id=uuid.UUID(document_id),
            chunk_index=0,
            content="Some indexed content.",
            embedding=[0.5] * 1536,
            token_count=4,
        )
    )
    await session.commit()

    response = await client.get(f"/api/v1/knowledge-bases/{kb['id']}/documents/{document_id}/chunks", headers=headers)
    assert response.status_code == 200
    assert set(response.json()[0]) == {"id", "document_id", "chunk_index", "content", "token_count"}


@pytest.mark.asyncio
async def test_deleting_a_knowledge_base_removes_its_documents(client: AsyncClient):
    headers, workspace_id = await _tenant(client, "kb")
    kb = await _create_kb(client, headers, workspace_id)
    await client.post(
        f"/api/v1/knowledge-bases/{kb['id']}/documents",
        files={"file": ("a.txt", b"content", "text/plain")},
        headers=headers,
    )

    deleted = await client.delete(f"/api/v1/knowledge-bases/{kb['id']}", headers=headers)
    assert deleted.status_code == 204
    assert (await client.get(f"/api/v1/knowledge-bases/{kb['id']}", headers=headers)).status_code == 404


# ---------------------------------------------------------------------------
# Delete is blocked while something still searches the corpus
#
# The same rule `ToolService.delete_tool` applies to a tool a published version
# references, and it inherits that rule's asymmetry: published references block,
# draft ones do not. Retrieval has two shapes of reference — a registry
# `knowledge_search` tool, and a node carrying `knowledge_base_id` inline — and
# both are checked, because both resolve the id at RUN time.
# ---------------------------------------------------------------------------


async def _retrieval_tool(client: AsyncClient, headers: dict, workspace_id: str, kb_id: str, name: str) -> dict:
    response = await client.post(
        "/api/v1/tools",
        json={
            "workspace_id": workspace_id,
            "name": name,
            "tool_type": "knowledge_search",
            # A registry retrieval row must carry a default question:
            # `_knowledge_search_config` refuses a config with neither `query`
            # nor `query_fields`, and a row that saves is a row that runs.
            "config": {"knowledge_base_id": kb_id, "query": "what is the approval threshold?"},
        },
        headers=headers,
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.asyncio
async def test_deleting_a_knowledge_base_a_registry_tool_searches_is_409(client: AsyncClient):
    headers, workspace_id = await _tenant(client, "kb")
    kb = await _create_kb(client, headers, workspace_id)
    tool = await _retrieval_tool(client, headers, workspace_id, kb["id"], "search_ap_policy")

    blocked = await client.delete(f"/api/v1/knowledge-bases/{kb['id']}", headers=headers)
    assert blocked.status_code == 409, blocked.text
    # The offending tool is NAMED, because editing it is the fix.
    assert "search_ap_policy" in blocked.json()["detail"]

    # Soft-deleting the tool releases the corpus: a tool that cannot be resolved
    # at run start references nothing that runs.
    assert (await client.delete(f"/api/v1/tools/{tool['id']}", headers=headers)).status_code == 204
    assert (await client.delete(f"/api/v1/knowledge-bases/{kb['id']}", headers=headers)).status_code == 204


@pytest.mark.asyncio
async def test_deleting_a_knowledge_base_a_published_node_searches_is_409(client: AsyncClient):
    """An inline `knowledge_base_id` in a PUBLISHED version blocks; a draft does not."""
    from test_workflow_versions import graph_payload
    from test_workflows import create_workflow, create_workspace, register_and_get_token

    from src.modules.workflows.schemas import EdgeInput, NodeInput, NodeType

    data = await register_and_get_token(client, "KB-REF")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    workspace = await create_workspace(client, token)
    kb = await _create_kb(client, headers, workspace["id"])
    workflow = await create_workflow(client, token, workspace["id"])

    nodes = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        NodeInput(
            node_key="search",
            node_type=NodeType.tool,
            config={"tool_type": "knowledge_search", "knowledge_base_id": kb["id"], "query": "approval threshold"},
            position_x=100,
            position_y=0,
        ),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=200, position_y=0),
    ]
    edges = [
        EdgeInput(source_node_key="start", target_node_key="search"),
        EdgeInput(source_node_key="search", target_node_key="end"),
    ]

    saved = await client.post(f"/api/v1/workflows/{workflow['id']}/versions", json=graph_payload(nodes, edges), headers=headers)
    assert saved.status_code == 201, saved.text
    version_id = saved.json()["id"]

    # While it is only a draft the author is still editing, so it must not block.
    assert (await client.get(f"/api/v1/knowledge-bases/{kb['id']}", headers=headers)).status_code == 200
    draft_delete_allowed = await client.delete(f"/api/v1/knowledge-bases/{kb['id']}", headers=headers)
    assert draft_delete_allowed.status_code == 204

    # Now do it again, published this time.
    kb2 = await _create_kb(client, headers, workspace["id"], name="AP Policy 2")
    nodes[1] = NodeInput(
        node_key="search",
        node_type=NodeType.tool,
        config={"tool_type": "knowledge_search", "knowledge_base_id": kb2["id"], "query": "approval threshold"},
        position_x=100,
        position_y=0,
    )
    saved = await client.post(f"/api/v1/workflows/{workflow['id']}/versions", json=graph_payload(nodes, edges), headers=headers)
    version_id = saved.json()["id"]
    published = await client.post(f"/api/v1/workflows/{workflow['id']}/versions/{version_id}/publish", headers=headers)
    assert published.status_code == 200, published.text

    blocked = await client.delete(f"/api/v1/knowledge-bases/{kb2['id']}", headers=headers)
    assert blocked.status_code == 409, blocked.text
    assert "published" in blocked.json()["detail"]


@pytest.mark.asyncio
async def test_another_orgs_reference_does_not_block_a_delete(client: AsyncClient):
    """The reference queries are org-scoped: a same-named tool elsewhere is not a reference."""
    headers_a, workspace_a = await _tenant(client, "kb-a")
    headers_b, workspace_b = await _tenant(client, "kb-b")

    kb_a = await _create_kb(client, headers_a, workspace_a)
    kb_b = await _create_kb(client, headers_b, workspace_b)
    await _retrieval_tool(client, headers_b, workspace_b, kb_b["id"], "search_ap_policy")

    # Org B's tool searches Org B's corpus; Org A's identically-shaped KB is free.
    assert (await client.delete(f"/api/v1/knowledge-bases/{kb_a['id']}", headers=headers_a)).status_code == 204
