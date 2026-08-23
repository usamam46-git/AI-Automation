"""
tests/test_tools.py — the tool registry CRUD surface (/api/v1/tools).

Vol. 2 §9.2 documents no tools endpoints, so what's pinned here is the derived
contract: §9.1's conventions (cursor pagination, tenant scope from the token),
§7.2's "registry IS the function-calling contract" (name grammar, uniqueness,
function_specs), and the write-time reuse of the executor's own validator.
"""

import uuid

import pytest
from fastapi import status
from httpx import AsyncClient

from src.modules.tools.service import ToolService
from src.modules.workflows.schemas import EdgeInput, NodeInput, NodeType
from tests.test_workflows import create_workflow, create_workspace, register_and_get_token

HTTP_TOOL = {
    "name": "lookup_vendor",
    "tool_type": "http_request",
    "description": "Look up a vendor by tax id.",
    "input_schema": {"type": "object", "properties": {"tax_id": {"type": "string"}}},
    "config": {"url": "https://erp.example.com/vendors", "method": "GET"},
}

ERP_TOOL = {
    "name": "post_journal_entry",
    "tool_type": "erp_connector",
    "description": "Post a journal entry to the ledger.",
    "config": {"action": "create_journal_entry"},
    "is_mutating": True,
}


async def _bootstrap(client: AsyncClient, suffix: str) -> dict:
    data = await register_and_get_token(client, suffix)
    token = data["access_token"]
    ws = await create_workspace(client, token)
    return {"token": token, "headers": {"Authorization": f"Bearer {token}"}, "workspace_id": ws["id"]}


async def _create_tool(client: AsyncClient, ctx: dict, **overrides) -> dict:
    payload = {**HTTP_TOOL, "workspace_id": ctx["workspace_id"], **overrides}
    resp = await client.post("/api/v1/tools", json=payload, headers=ctx["headers"])
    assert resp.status_code == status.HTTP_201_CREATED, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# CRUD lifecycle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_read_update_delete_lifecycle(client: AsyncClient):
    ctx = await _bootstrap(client, "T-crud")

    tool = await _create_tool(client, ctx)
    assert tool["is_mutating"] is False
    assert tool["is_active"] is True
    assert tool["tool_type"] == "http_request"

    got = await client.get(f"/api/v1/tools/{tool['id']}", headers=ctx["headers"])
    assert got.status_code == 200
    assert got.json()["name"] == "lookup_vendor"

    patched = await client.patch(
        f"/api/v1/tools/{tool['id']}",
        json={"description": "Now with feeling."},
        headers=ctx["headers"],
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["description"] == "Now with feeling."

    deleted = await client.delete(f"/api/v1/tools/{tool['id']}", headers=ctx["headers"])
    assert deleted.status_code == status.HTTP_204_NO_CONTENT

    # Soft delete: gone from the API, still a row underneath.
    assert (await client.get(f"/api/v1/tools/{tool['id']}", headers=ctx["headers"])).status_code == 404


@pytest.mark.asyncio
async def test_organization_id_comes_from_the_token_not_the_body(client: AsyncClient):
    """A client-settable organization_id is a bug — the field must not exist."""
    ctx = await _bootstrap(client, "T-org")
    foreign_org = str(uuid.uuid4())

    resp = await client.post(
        "/api/v1/tools",
        json={**HTTP_TOOL, "workspace_id": ctx["workspace_id"], "organization_id": foreign_org},
        headers=ctx["headers"],
    )
    assert resp.status_code == status.HTTP_201_CREATED, resp.text
    assert resp.json()["organization_id"] != foreign_org


@pytest.mark.asyncio
async def test_create_against_another_orgs_workspace_is_404(client: AsyncClient):
    a = await _bootstrap(client, "T-wsA")
    b = await _bootstrap(client, "T-wsB")

    resp = await client.post(
        "/api/v1/tools",
        json={**HTTP_TOOL, "workspace_id": a["workspace_id"]},
        headers=b["headers"],
    )
    assert resp.status_code == status.HTTP_404_NOT_FOUND


@pytest.mark.asyncio
async def test_cross_tenant_access_is_404_never_403(client: AsyncClient):
    a = await _bootstrap(client, "T-isoA")
    b = await _bootstrap(client, "T-isoB")
    tool = await _create_tool(client, a)

    assert (await client.get(f"/api/v1/tools/{tool['id']}", headers=b["headers"])).status_code == 404
    assert (await client.patch(f"/api/v1/tools/{tool['id']}", json={"description": "x"}, headers=b["headers"])).status_code == 404
    assert (await client.delete(f"/api/v1/tools/{tool['id']}", headers=b["headers"])).status_code == 404

    # And it is untouched from A's side.
    still_there = await client.get(f"/api/v1/tools/{tool['id']}", headers=a["headers"])
    assert still_there.status_code == 200
    assert still_there.json()["description"] == HTTP_TOOL["description"]


# ---------------------------------------------------------------------------
# List: filters, pagination
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_filters_by_workspace_and_type(client: AsyncClient):
    ctx = await _bootstrap(client, "T-filter")
    second_ws = await create_workspace(client, ctx["token"], name="Second WS")

    await _create_tool(client, ctx, name="http_one")
    await _create_tool(client, ctx, **{**ERP_TOOL, "name": "erp_one"})
    await _create_tool(client, ctx, name="other_ws_tool", workspace_id=second_ws["id"])

    everything = await client.get("/api/v1/tools", headers=ctx["headers"])
    assert everything.status_code == 200
    assert len(everything.json()) == 3

    by_ws = await client.get(f"/api/v1/tools?workspace_id={second_ws['id']}", headers=ctx["headers"])
    assert [t["name"] for t in by_ws.json()] == ["other_ws_tool"]

    by_type = await client.get("/api/v1/tools?tool_type=erp_connector", headers=ctx["headers"])
    assert [t["name"] for t in by_type.json()] == ["erp_one"]


@pytest.mark.asyncio
async def test_list_cursor_pagination(client: AsyncClient):
    ctx = await _bootstrap(client, "T-page")
    for i in range(3):
        await _create_tool(client, ctx, name=f"tool_{i}")

    first = await client.get("/api/v1/tools?limit=2", headers=ctx["headers"])
    assert first.status_code == 200
    page_one = first.json()
    assert len(page_one) == 2

    second = await client.get(f"/api/v1/tools?limit=2&cursor={page_one[-1]['created_at']}", headers=ctx["headers"])
    assert second.status_code == 200
    page_two = second.json()
    assert len(page_two) == 1

    ids = {t["id"] for t in page_one} | {t["id"] for t in page_two}
    assert len(ids) == 3


@pytest.mark.asyncio
async def test_unparseable_cursor_is_ignored_not_a_422(client: AsyncClient):
    """Same convention as workspaces/executions — a junk cursor degrades to page one."""
    ctx = await _bootstrap(client, "T-cursor")
    await _create_tool(client, ctx)

    resp = await client.get("/api/v1/tools?cursor=not-a-datetime", headers=ctx["headers"])
    assert resp.status_code == 200
    assert len(resp.json()) == 1


# ---------------------------------------------------------------------------
# Validation — the registry rejects what the executor would reject
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("tool_type", ["python_function", "mcp"])
@pytest.mark.asyncio
async def test_unimplemented_tool_types_are_rejected_at_create(client: AsyncClient, tool_type: str):
    """
    Vol. 2 §7.2 defines four types; only two execute. Storing a row for the other
    two would let an author register a tool that fails only at run time — and, once
    the ReAct loop lands, expose an unexecutable function spec to a model.
    """
    ctx = await _bootstrap(client, f"T-{tool_type}")
    resp = await client.post(
        "/api/v1/tools",
        json={**HTTP_TOOL, "workspace_id": ctx["workspace_id"], "tool_type": tool_type, "config": {}},
        headers=ctx["headers"],
    )
    assert resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY, resp.text
    assert tool_type in resp.json()["detail"]


@pytest.mark.parametrize(
    ("label", "overrides"),
    [
        ("missing url", {"config": {"method": "GET"}}),
        ("bad method", {"config": {"url": "https://x.test", "method": "TRACE"}}),
        ("headers not an object", {"config": {"url": "https://x.test", "headers": "nope"}}),
        ("malformed body_fields", {"config": {"url": "https://x.test", "body_fields": {"vendor": 5}}}),
        ("missing erp action", {"tool_type": "erp_connector", "config": {}}),
        ("unknown erp action", {"tool_type": "erp_connector", "config": {"action": "delete_ledger"}}),
    ],
)
@pytest.mark.asyncio
async def test_config_errors_surface_as_422(client: AsyncClient, label: str, overrides: dict):
    ctx = await _bootstrap(client, "T-cfg")
    resp = await client.post(
        "/api/v1/tools",
        json={**HTTP_TOOL, "workspace_id": ctx["workspace_id"], **overrides},
        headers=ctx["headers"],
    )
    assert resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY, f"{label}: {resp.text}"


@pytest.mark.parametrize("bad_name", ["has spaces", "has.dots", "sym!bol", "x" * 65, ""])
@pytest.mark.asyncio
async def test_name_must_match_openai_function_grammar(client: AsyncClient, bad_name: str):
    ctx = await _bootstrap(client, "T-name")
    resp = await client.post(
        "/api/v1/tools",
        json={**HTTP_TOOL, "workspace_id": ctx["workspace_id"], "name": bad_name},
        headers=ctx["headers"],
    )
    assert resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_duplicate_name_in_same_workspace_is_409(client: AsyncClient):
    ctx = await _bootstrap(client, "T-dupe")
    await _create_tool(client, ctx)

    resp = await client.post(
        "/api/v1/tools",
        json={**HTTP_TOOL, "workspace_id": ctx["workspace_id"]},
        headers=ctx["headers"],
    )
    assert resp.status_code == status.HTTP_409_CONFLICT, resp.text


@pytest.mark.asyncio
async def test_same_name_in_a_different_workspace_is_allowed(client: AsyncClient):
    """Uniqueness is per workspace, not per org — the function-spec array is per workspace."""
    ctx = await _bootstrap(client, "T-dupe-ws")
    other = await create_workspace(client, ctx["token"], name="Other WS")

    await _create_tool(client, ctx)
    await _create_tool(client, ctx, workspace_id=other["id"])


@pytest.mark.asyncio
async def test_tool_type_and_workspace_are_immutable(client: AsyncClient):
    ctx = await _bootstrap(client, "T-immutable")
    tool = await _create_tool(client, ctx)

    for field, value in (("tool_type", "erp_connector"), ("workspace_id", str(uuid.uuid4()))):
        resp = await client.patch(f"/api/v1/tools/{tool['id']}", json={field: value}, headers=ctx["headers"])
        assert resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY, f"{field} should be rejected: {resp.text}"


@pytest.mark.asyncio
async def test_patch_revalidates_config_against_the_executor(client: AsyncClient):
    ctx = await _bootstrap(client, "T-patch-cfg")
    tool = await _create_tool(client, ctx)

    resp = await client.patch(
        f"/api/v1/tools/{tool['id']}",
        json={"config": {"url": "https://x.test", "method": "TRACE"}},
        headers=ctx["headers"],
    )
    assert resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


@pytest.mark.parametrize(
    "bad_schema",
    [
        {"type": "array", "items": {}},
        {"type": "object", "properties": "not-an-object"},
    ],
)
@pytest.mark.asyncio
async def test_input_schema_shallow_validation(client: AsyncClient, bad_schema: dict):
    ctx = await _bootstrap(client, "T-schema")
    resp = await client.post(
        "/api/v1/tools",
        json={**HTTP_TOOL, "workspace_id": ctx["workspace_id"], "input_schema": bad_schema},
        headers=ctx["headers"],
    )
    assert resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY, resp.text


# ---------------------------------------------------------------------------
# Delete guard
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_blocked_while_a_published_version_references_the_tool(client: AsyncClient):
    """
    Published versions are immutable, so their nodes can never drop the reference.
    Deleting the tool would turn every future run of that workflow into a
    resolution failure, so the delete is refused with a 409.
    """
    ctx = await _bootstrap(client, "T-refs")
    tool = await _create_tool(client, ctx, **{**ERP_TOOL, "name": "post_je_tool"})
    wf = await create_workflow(client, ctx["token"], ctx["workspace_id"])

    nodes = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        NodeInput(node_key="approve", node_type=NodeType.human_approval, config={}, position_x=100, position_y=0),
        NodeInput(node_key="post_je", node_type=NodeType.tool, config={"tool_id": tool["id"]}, position_x=200, position_y=0),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=300, position_y=0),
    ]
    edges = [
        EdgeInput(source_node_key="start", target_node_key="approve"),
        EdgeInput(source_node_key="approve", target_node_key="post_je"),
        EdgeInput(source_node_key="post_je", target_node_key="end"),
    ]
    payload = {
        "nodes": [n.model_dump(mode="json") for n in nodes],
        "edges": [e.model_dump(mode="json") for e in edges],
    }

    saved = await client.post(f"/api/v1/workflows/{wf['id']}/versions", json=payload, headers=ctx["headers"])
    assert saved.status_code == status.HTTP_201_CREATED, saved.text

    # A draft reference does not block — the author is still editing.
    assert (await client.delete(f"/api/v1/tools/{tool['id']}", headers=ctx["headers"])).status_code == 204

    # Restore it (soft delete is reversible only via the DB, so make a fresh one
    # under a new name) and publish this time.
    tool2 = await _create_tool(client, ctx, **{**ERP_TOOL, "name": "post_je_live"})
    nodes[2] = NodeInput(node_key="post_je", node_type=NodeType.tool, config={"tool_id": tool2["id"]}, position_x=200, position_y=0)
    payload["nodes"] = [n.model_dump(mode="json") for n in nodes]

    saved = await client.post(f"/api/v1/workflows/{wf['id']}/versions", json=payload, headers=ctx["headers"])
    assert saved.status_code == status.HTTP_201_CREATED, saved.text
    version_id = saved.json()["id"]

    published = await client.post(f"/api/v1/workflows/{wf['id']}/versions/{version_id}/publish", headers=ctx["headers"])
    assert published.status_code == 200, published.text

    blocked = await client.delete(f"/api/v1/tools/{tool2['id']}", headers=ctx["headers"])
    assert blocked.status_code == status.HTTP_409_CONFLICT, blocked.text
    assert "published" in blocked.json()["detail"]


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_viewer_cannot_write_tools(client: AsyncClient, session):
    from sqlalchemy import select
    from sqlalchemy import update as sa_update

    from src.core.cache import invalidate_permissions_cache
    from src.core.redis import get_redis
    from src.core.security import decode_access_token
    from src.modules.auth.models import OrgMembership, Role

    ctx = await _bootstrap(client, "T-viewer")
    claims = decode_access_token(ctx["token"])
    user_id = uuid.UUID(claims["user_id"])
    org_id = uuid.UUID(claims["org_id"])

    viewer = (await session.execute(select(Role).where(Role.name == "Viewer", Role.is_system.is_(True)))).scalars().first()
    assert viewer is not None, "Viewer system role must be seeded"
    await session.execute(
        sa_update(OrgMembership).where(OrgMembership.user_id == user_id, OrgMembership.organization_id == org_id).values(role_id=viewer.id)
    )
    await session.commit()

    # Registration cached Owner's "*"; without eviction this passes vacuously.
    await invalidate_permissions_cache(await get_redis(), str(org_id), str(user_id))

    write = await client.post("/api/v1/tools", json={**HTTP_TOOL, "workspace_id": ctx["workspace_id"]}, headers=ctx["headers"])
    assert write.status_code == status.HTTP_403_FORBIDDEN
    assert "tool:write" in write.json()["detail"]

    # Viewer's "*:read" still covers tool:read.
    assert (await client.get("/api/v1/tools", headers=ctx["headers"])).status_code == 200


# ---------------------------------------------------------------------------
# function_specs — Vol. 2 §7.2's claim, made literal
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_function_specs_builds_openai_shape_in_requested_order(client: AsyncClient, session):
    ctx = await _bootstrap(client, "T-specs")
    first = await _create_tool(client, ctx, name="alpha_tool")
    second = await _create_tool(client, ctx, name="beta_tool")

    from src.core.security import decode_access_token

    org_id = uuid.UUID(decode_access_token(ctx["token"])["org_id"])
    service = ToolService(session)

    ordered = [uuid.UUID(second["id"]), uuid.UUID(first["id"])]
    specs = await service.function_specs(org_id, ordered)

    assert [s["function"]["name"] for s in specs] == ["beta_tool", "alpha_tool"]
    assert specs[0]["type"] == "function"
    assert specs[0]["function"]["parameters"] == HTTP_TOOL["input_schema"]
    assert specs[0]["function"]["description"] == HTTP_TOOL["description"]


@pytest.mark.asyncio
async def test_function_specs_skips_unresolvable_and_cross_org_ids(client: AsyncClient, session):
    a = await _bootstrap(client, "T-specsA")
    b = await _bootstrap(client, "T-specsB")
    mine = await _create_tool(client, a, name="mine_tool")
    theirs = await _create_tool(client, b, name="theirs_tool")

    from src.core.security import decode_access_token

    org_a = uuid.UUID(decode_access_token(a["token"])["org_id"])
    specs = await ToolService(session).function_specs(org_a, [uuid.UUID(mine["id"]), uuid.UUID(theirs["id"]), uuid.uuid4()])

    assert [s["function"]["name"] for s in specs] == ["mine_tool"]


@pytest.mark.asyncio
async def test_function_specs_defaults_an_absent_input_schema(client: AsyncClient, session):
    """A tool with no input_schema must still produce a valid function spec."""
    ctx = await _bootstrap(client, "T-specs-empty")
    tool = await _create_tool(client, ctx, name="no_schema_tool", input_schema=None, description=None)

    from src.core.security import decode_access_token

    org_id = uuid.UUID(decode_access_token(ctx["token"])["org_id"])
    specs = await ToolService(session).function_specs(org_id, [uuid.UUID(tool["id"])])

    assert specs[0]["function"]["parameters"] == {"type": "object", "properties": {}}
    assert specs[0]["function"]["description"] == ""


# ---------------------------------------------------------------------------
# Encrypted tool credentials (2026-08-23)
#
# Before this, a tool's API key lived in `config.headers` as plaintext JSONB and
# was returned verbatim by every read endpoint. `models.py` described the column
# as holding an "auth reference", which is what the design should have been and
# was not. These tests pin the three properties that matter: the value never
# comes back over HTTP, it is not readable in the row, and a reference to a
# secret that does not exist fails at write time rather than as a 401 later.
# ---------------------------------------------------------------------------


SECRET_TOOL = {
    "name": "post_je_secure",
    "tool_type": "http_request",
    "description": "Post a journal entry to the real ledger.",
    "config": {
        "url": "https://erp.example.com/api/journal-entries",
        "method": "POST",
        "headers": {"Authorization": "Bearer {{secrets.erp_token}}"},
        "idempotency": {"header": "Idempotency-Key"},
    },
    "secrets": {"erp_token": "sk-live-DO-NOT-LEAK-0001"},
    "is_mutating": True,
}


@pytest.mark.asyncio
async def test_a_tool_secret_is_never_returned_by_any_endpoint(client: AsyncClient):
    ctx = await _bootstrap(client, "T-sec1")
    created = await _create_tool(client, ctx, **SECRET_TOOL)

    assert created["secret_keys"] == ["erp_token"]
    assert "secrets" not in created

    detail = await client.get(f"/api/v1/tools/{created['id']}", headers=ctx["headers"])
    listing = await client.get("/api/v1/tools", headers=ctx["headers"])

    for resp in (detail, listing):
        assert "sk-live-DO-NOT-LEAK-0001" not in resp.text
    assert detail.json()["secret_keys"] == ["erp_token"]
    # The placeholder itself is fine to expose — it names a credential, it is not one.
    assert detail.json()["config"]["headers"]["Authorization"] == "Bearer {{secrets.erp_token}}"


@pytest.mark.asyncio
async def test_a_tool_secret_is_not_readable_in_the_row(client: AsyncClient, session):
    """The gap this closed was at rest, not in transit — pg_dump, replicas, backups."""
    from sqlalchemy import select

    from src.modules.tools.models import Tool

    ctx = await _bootstrap(client, "T-sec2")
    created = await _create_tool(client, ctx, **SECRET_TOOL)

    row = (await session.execute(select(Tool).where(Tool.id == uuid.UUID(created["id"])))).scalar_one()
    assert b"sk-live-DO-NOT-LEAK-0001" not in bytes(row.secrets_encrypted)
    assert "sk-live-DO-NOT-LEAK-0001" not in str(row.config)


@pytest.mark.asyncio
async def test_referencing_an_unknown_secret_is_rejected_at_write_time(client: AsyncClient):
    ctx = await _bootstrap(client, "T-sec3")
    resp = await client.post(
        "/api/v1/tools",
        json={**SECRET_TOOL, "workspace_id": ctx["workspace_id"], "secrets": {"other_name": "x"}},
        headers=ctx["headers"],
    )
    assert resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    assert "erp_token" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_removing_a_secret_a_config_still_references_is_rejected(client: AsyncClient):
    """Otherwise the tool silently starts sending `Bearer {{secrets.erp_token}}` as a literal."""
    ctx = await _bootstrap(client, "T-sec4")
    created = await _create_tool(client, ctx, **SECRET_TOOL)

    resp = await client.patch(f"/api/v1/tools/{created['id']}", json={"secrets": {}}, headers=ctx["headers"])
    assert resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    assert "erp_token" in resp.json()["detail"]
