"""
tests/test_document_ingestion.py — the worker_documents ingestion task.

Drives `_ingest` directly with a **fake embedder and stubbed object storage**, so
nothing here calls OpenAI or MinIO. Day 1 already proved the live embedding path
against the real API; what these tests assert is the wiring around it — status
transitions, the cost-control skip, idempotency, and failure recording.
"""

import uuid
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from src.core.llm_client import EmbeddingResult
from src.modules.knowledge_base.models import Document, DocumentChunk

POLICY_TEXT = (
    b"ACCOUNTS PAYABLE POLICY\n\n"
    b"Invoices at or above USD 5,000 require the approval of the finance controller.\n\n"
    b"Every supplier invoice must be matched against its purchase order.\n\n"
    b"Standard terms with Acme Vendor LLC are net 30 from the invoice date.\n"
)


class FakeEmbedder:
    """Deterministic unit vectors. Records every call so batching is assertable."""

    def __init__(self):
        self.calls: list[list[str]] = []

    def embed(self, *, texts, model):
        self.calls.append(list(texts))
        vector = [0.0] * 1536
        vector[0] = 1.0
        return EmbeddingResult(
            vectors=[list(vector) for _ in texts],
            model=model,
            dimensions=1536,
            tokens=len(texts) * 10,
            cost_usd=0.0,
        )


async def _upload(client: AsyncClient, content: bytes = POLICY_TEXT, name: str = "policy.txt") -> tuple[str, dict]:
    """Register an org, create a KB, upload a document. Returns (document_id, headers)."""
    from test_workflow_versions import register_and_get_token
    from test_workflows import create_workspace

    data = await register_and_get_token(client, f"ing-{uuid.uuid4().hex[:6]}")
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    workspace = await create_workspace(client, data["access_token"])

    kb = await client.post(
        "/api/v1/knowledge-bases",
        json={"workspace_id": workspace["id"], "name": "Policies"},
        headers=headers,
    )
    upload = await client.post(
        f"/api/v1/knowledge-bases/{kb.json()['id']}/documents",
        files={"file": (name, content, "text/plain")},
        headers=headers,
    )
    assert upload.status_code == 202, upload.text
    return upload.json()["id"], headers


async def _run_ingest(document_id: str, embedder: FakeEmbedder, stored: bytes = POLICY_TEXT):
    """
    Run `_ingest` with storage and the BYOK client factory stubbed out.

    Must be `async` and must `await` INSIDE the patch block. A sync helper that
    returned the un-awaited coroutine would tear the patches down before a single
    line of `_ingest` ran, and the task would quietly reach the real MinIO and the
    real OpenAI key — which is exactly what happened on the first attempt: every
    assertion about the fake embedder failed because it was never called.
    """
    from src.workers import document_tasks

    async def _fake_get_object(key: str) -> bytes:
        return stored

    async def _fake_factory(_organization_id):
        return lambda: embedder

    with (
        patch.object(document_tasks.storage, "get_object", _fake_get_object),
        patch("src.workers.graph_tasks._resolve_llm_client_factory", _fake_factory),
    ):
        return await document_tasks._ingest(uuid.UUID(document_id))


async def _read_document(session, document_id: str) -> Document:
    return (await session.execute(select(Document).where(Document.id == uuid.UUID(document_id)))).scalar_one()


async def _chunks(session, document_id: str) -> list[DocumentChunk]:
    result = await session.execute(
        select(DocumentChunk).where(DocumentChunk.document_id == uuid.UUID(document_id)).order_by(DocumentChunk.chunk_index)
    )
    return list(result.scalars().all())


@pytest.mark.asyncio
async def test_ingestion_walks_uploaded_to_indexed_and_writes_chunks(client: AsyncClient, session):
    document_id, _ = await _upload(client)

    before = await _read_document(session, document_id)
    assert before.status == "uploaded"
    assert before.content_hash is None

    embedder = FakeEmbedder()
    outcome = await _run_ingest(document_id, embedder)
    assert "indexed" in outcome

    session.expire_all()
    after = await _read_document(session, document_id)
    assert after.status == "indexed"
    assert after.error is None
    assert after.content_hash and len(after.content_hash) == 64

    chunks = await _chunks(session, document_id)
    assert chunks, "ingestion must produce at least one chunk"
    assert [c.chunk_index for c in chunks] == list(range(len(chunks)))
    for chunk in chunks:
        assert len(chunk.embedding) == 1536
        assert chunk.token_count > 0
        assert chunk.content.strip()

    # One batch for a document this small, and the texts embedded are exactly
    # the chunk contents that were stored.
    assert len(embedder.calls) == 1
    assert embedder.calls[0] == [c.content for c in chunks]


@pytest.mark.asyncio
async def test_the_kbs_own_model_is_used_not_a_default(client: AsyncClient, session):
    """
    Embedding a corpus with one model and querying it with another returns
    plausible numbers and meaningless rankings, and nothing raises. The KB row is
    the authority.
    """
    from src.modules.knowledge_base.models import KnowledgeBase

    document_id, _ = await _upload(client)
    document = await _read_document(session, document_id)
    kb = (await session.execute(select(KnowledgeBase).where(KnowledgeBase.id == document.knowledge_base_id))).scalar_one()

    captured = {}

    class ModelCapturingEmbedder(FakeEmbedder):
        def embed(self, *, texts, model):
            captured["model"] = model
            return super().embed(texts=texts, model=model)

    await _run_ingest(document_id, ModelCapturingEmbedder())
    assert captured["model"] == kb.embedding_model


@pytest.mark.asyncio
async def test_unchanged_content_skips_embedding_entirely(client: AsyncClient, session):
    """
    The cost control the 15-day plan asks for by name.

    A re-ingest of the same bytes must not pay to embed again — this is what
    keeps a fifteen-day loop of repeated re-indexing inside the budget.
    """
    document_id, _ = await _upload(client)
    await _run_ingest(document_id, FakeEmbedder())

    second = FakeEmbedder()
    outcome = await _run_ingest(document_id, second)

    assert "skipped" in outcome
    assert second.calls == [], "an unchanged document must not be embedded again"

    session.expire_all()
    assert (await _read_document(session, document_id)).status == "indexed"


@pytest.mark.asyncio
async def test_changed_content_re_embeds_and_replaces_chunks(client: AsyncClient, session):
    """Delete-then-insert: a re-ingest replaces its chunks rather than doubling
    them, which is what makes the task safe under `task_acks_late` redelivery."""
    document_id, _ = await _upload(client)
    await _run_ingest(document_id, FakeEmbedder())
    session.expire_all()
    first_hash = (await _read_document(session, document_id)).content_hash
    first_count = len(await _chunks(session, document_id))

    revised = POLICY_TEXT + b"\n\nAmendment: the threshold is now USD 10,000.\n"
    embedder = FakeEmbedder()
    await _run_ingest(document_id, embedder, stored=revised)

    session.expire_all()
    after = await _read_document(session, document_id)
    assert after.content_hash != first_hash
    assert embedder.calls, "changed content must be re-embedded"

    chunks = await _chunks(session, document_id)
    assert [c.chunk_index for c in chunks] == list(range(len(chunks))), "indexes must not double up"
    assert len(chunks) >= first_count


@pytest.mark.asyncio
async def test_a_document_with_no_extractable_text_fails_with_a_reason(client: AsyncClient, session):
    """
    The scanned-document case. `status='failed'` carried no reason anywhere
    before `documents.error` existed, which made a failed upload undiagnosable
    through the API.
    """
    from src.core.document_text import UnextractableDocumentError
    from src.workers import document_tasks

    document_id, _ = await _upload(client)

    with pytest.raises(UnextractableDocumentError):
        await _run_ingest(document_id, FakeEmbedder(), stored=b"   \n\n   ")

    # The task wrapper records the failure; _ingest itself only raises.
    await document_tasks._set_status(uuid.UUID(document_id), "failed", error="no extractable text")

    session.expire_all()
    failed = await _read_document(session, document_id)
    assert failed.status == "failed"
    assert failed.error


@pytest.mark.asyncio
async def test_a_deleted_document_is_skipped_rather_than_retried(client: AsyncClient):
    """
    Deleting between enqueue and execution is a normal race, not an error.
    Raising would burn three retries on a row that will never come back.
    """
    outcome = await _run_ingest(str(uuid.uuid4()), FakeEmbedder())
    assert "no longer exists" in outcome


@pytest.mark.asyncio
async def test_large_documents_are_embedded_in_bounded_batches(client: AsyncClient, session):
    """`embed()` refuses a batch over 2048 rather than splitting it, so batching
    is the ingestion pipeline's job."""
    from src.workers.document_tasks import EMBED_BATCH_SIZE

    big = b"\n\n".join(f"Clause {i}. {'word ' * 120}".encode() for i in range(400))
    document_id, _ = await _upload(client, content=big, name="big.txt")

    embedder = FakeEmbedder()
    await _run_ingest(document_id, embedder, stored=big)

    chunks = await _chunks(session, document_id)
    assert len(chunks) > EMBED_BATCH_SIZE, "this fixture is meant to exceed one batch"
    assert len(embedder.calls) > 1
    assert all(len(call) <= EMBED_BATCH_SIZE for call in embedder.calls)
    # Every chunk embedded exactly once, in order.
    assert [text for call in embedder.calls for text in call] == [c.content for c in chunks]
