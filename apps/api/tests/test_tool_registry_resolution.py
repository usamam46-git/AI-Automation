"""
tests/test_tool_registry_resolution.py — resolving a node's `tool_id` against the
tools registry at run start (Vol. 2 §7.2).

The contract being pinned:
- inline `tool_type` config ALWAYS wins over a `tool_id`, forever;
- a resolved tool lands in exactly the shape `_tool_config` already accepts, so
  `tool_handler` never learns the registry exists;
- the node may override only per-usage state wiring, never the registry's own
  `url`/`method`/`headers`/`action`/`timeout_seconds`/`is_mutating`;
- an unresolvable reference fails the run fast, not mid-graph.
"""

import uuid
from typing import Any

import pytest
from fastapi import status
from httpx import AsyncClient
from sqlalchemy.orm import selectinload

from src.db.database import async_session_maker
from src.graphs.compiler import _bind_node_handler
from src.graphs.node_handlers import ToolNodeConfigError
from src.modules.tools.service import ToolService
from src.modules.workflows.models import WorkflowNode, WorkflowVersion
from src.modules.workflows.schemas import EdgeInput, NodeInput, NodeType
from tests.test_workflows import create_workflow, create_workspace, register_and_get_token

ERP_TOOL_CONFIG = {"action": "create_journal_entry"}


def _node(key: str, config: dict | None) -> WorkflowNode:
    return WorkflowNode(
        id=uuid.uuid4(),
        workflow_version_id=uuid.uuid4(),
        node_key=key,
        node_type="tool",
        config=config or {},
        position_x=0.0,
        position_y=0.0,
    )


async def _ctx(client: AsyncClient, suffix: str) -> dict[str, Any]:
    from src.core.security import decode_access_token

    data = await register_and_get_token(client, suffix)
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    ws = await create_workspace(client, token)
    return {
        "token": token,
        "headers": headers,
        "workspace_id": ws["id"],
        "org_id": uuid.UUID(decode_access_token(token)["org_id"]),
    }


async def _make_tool(client: AsyncClient, ctx: dict, name: str, **overrides) -> dict:
    payload = {
        "workspace_id": ctx["workspace_id"],
        "name": name,
        "tool_type": "erp_connector",
        "config": ERP_TOOL_CONFIG,
        "is_mutating": True,
        **overrides,
    }
    resp = await client.post("/api/v1/tools", json=payload, headers=ctx["headers"])
    assert resp.status_code == status.HTTP_201_CREATED, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# ToolService.resolve_node_configs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_registry_tool_resolves_into_inline_config_shape(client: AsyncClient, session):
    ctx = await _ctx(client, "R-shape")
    tool = await _make_tool(client, ctx, "post_je")

    resolved = await ToolService(session).resolve_node_configs(ctx["org_id"], [_node("post_je", {"tool_id": tool["id"]})])

    assert resolved["post_je"]["tool_type"] == "erp_connector"
    assert resolved["post_je"]["action"] == "create_journal_entry"
    assert resolved["post_je"]["is_mutating"] is True

    # And it is a shape the executor's own validator accepts unchanged.
    from src.graphs.node_handlers import validate_tool_config

    validate_tool_config(resolved["post_je"], "post_je")


@pytest.mark.asyncio
async def test_inline_tool_type_wins_over_tool_id(client: AsyncClient, session):
    """
    The no-break rule. Every pre-registry graph, and everything the Builder's
    node catalog emits, carries inline config — resolution must not touch it.
    """
    ctx = await _ctx(client, "R-inline")
    tool = await _make_tool(client, ctx, "post_je")

    node = _node("post_je", {"tool_type": "erp_connector", "action": "post_journal_entry", "tool_id": tool["id"]})
    resolved = await ToolService(session).resolve_node_configs(ctx["org_id"], [node])

    assert resolved == {}


@pytest.mark.asyncio
async def test_node_may_override_only_state_wiring(client: AsyncClient, session):
    """
    A node that could override `action` (or `url`, or `is_mutating`) would let an
    author redirect a tool the org reviewed, while the publish gate went on reading
    the registry row it no longer describes.
    """
    ctx = await _ctx(client, "R-override")
    tool = await _make_tool(client, ctx, "post_je")

    node = _node(
        "post_je",
        {
            "tool_id": tool["id"],
            "payload_fields": {"vendor": "node_outputs.extract.vendor"},  # allowed
            "action": "post_journal_entry",  # ignored
            "is_mutating": False,  # ignored
            "url": "https://evil.test",  # ignored
        },
    )
    resolved = (await ToolService(session).resolve_node_configs(ctx["org_id"], [node]))["post_je"]

    assert resolved["payload_fields"] == {"vendor": "node_outputs.extract.vendor"}
    assert resolved["action"] == "create_journal_entry"
    assert resolved["is_mutating"] is True
    assert "url" not in resolved


@pytest.mark.asyncio
async def test_http_tool_body_fields_override_is_allowed(client: AsyncClient, session):
    ctx = await _ctx(client, "R-http")
    tool = await _make_tool(
        client,
        ctx,
        "lookup_vendor",
        tool_type="http_request",
        config={"url": "https://erp.test/vendors", "method": "POST", "headers": {"Authorization": "Bearer secret"}},
        is_mutating=False,
    )

    node = _node("lookup", {"tool_id": tool["id"], "body_fields": {"tax_id": "node_outputs.extract.tax_id"}})
    resolved = (await ToolService(session).resolve_node_configs(ctx["org_id"], [node]))["lookup"]

    assert resolved["url"] == "https://erp.test/vendors"
    assert resolved["method"] == "POST"
    assert resolved["body_fields"] == {"tax_id": "node_outputs.extract.tax_id"}


@pytest.mark.asyncio
async def test_unresolvable_tool_id_raises_tool_node_config_error(client: AsyncClient, session):
    """
    Non-retryable in graph_tasks, so the run fails fast with a clear message rather
    than dying halfway through the graph. Publish already blocks this case; what
    reaches here is a tool soft-deleted after the version was published.
    """
    ctx = await _ctx(client, "R-missing")

    with pytest.raises(ToolNodeConfigError, match="not in this organization's registry"):
        await ToolService(session).resolve_node_configs(ctx["org_id"], [_node("post_je", {"tool_id": str(uuid.uuid4())})])


@pytest.mark.asyncio
async def test_soft_deleted_tool_becomes_unresolvable(client: AsyncClient, session):
    ctx = await _ctx(client, "R-deleted")
    tool = await _make_tool(client, ctx, "post_je")
    assert (await client.delete(f"/api/v1/tools/{tool['id']}", headers=ctx["headers"])).status_code == 204

    with pytest.raises(ToolNodeConfigError):
        await ToolService(session).resolve_node_configs(ctx["org_id"], [_node("post_je", {"tool_id": tool["id"]})])


@pytest.mark.asyncio
async def test_another_orgs_tool_is_unresolvable(client: AsyncClient, session):
    a = await _ctx(client, "R-crossA")
    b = await _ctx(client, "R-crossB")
    theirs = await _make_tool(client, b, "their_tool")

    with pytest.raises(ToolNodeConfigError):
        await ToolService(session).resolve_node_configs(a["org_id"], [_node("post_je", {"tool_id": theirs["id"]})])


@pytest.mark.asyncio
async def test_malformed_tool_id_raises_rather_than_silently_skipping(client: AsyncClient, session):
    ctx = await _ctx(client, "R-malformed")

    with pytest.raises(ToolNodeConfigError, match="malformed 'tool_id'"):
        await ToolService(session).resolve_node_configs(ctx["org_id"], [_node("post_je", {"tool_id": "not-a-uuid"})])


@pytest.mark.asyncio
async def test_non_tool_nodes_and_bare_nodes_are_ignored(client: AsyncClient, session):
    ctx = await _ctx(client, "R-ignore")
    agent = WorkflowNode(
        id=uuid.uuid4(),
        workflow_version_id=uuid.uuid4(),
        node_key="extract",
        node_type="agent",
        config={"tool_id": str(uuid.uuid4())},
        position_x=0.0,
        position_y=0.0,
    )
    assert await ToolService(session).resolve_node_configs(ctx["org_id"], [agent, _node("bare", {})]) == {}


# ---------------------------------------------------------------------------
# Compiler binding
# ---------------------------------------------------------------------------


def test_bind_node_handler_prefers_a_resolved_config():
    node = _node("post_je", {"tool_id": str(uuid.uuid4())})
    resolved = {
        "post_je": {
            "tool_type": "erp_connector",
            "action": "create_journal_entry",
            "is_mutating": True,
            "payload": {"vendor": "Acme", "amount": 1, "account_code": "5000"},
        }
    }

    handler = _bind_node_handler(node, tool_configs=resolved)
    result = handler({"node_outputs": {}})

    posted = result["node_outputs"]["post_je"]
    assert posted["posted"] is True
    assert posted["action"] == "create_journal_entry"


def test_bind_node_handler_without_tool_configs_is_the_pre_registry_path():
    """The default must reproduce today's behavior byte for byte."""
    inline = {"tool_type": "erp_connector", "action": "post_journal_entry", "payload": {"vendor": "A", "amount": 1, "account_code": "5"}}
    handler = _bind_node_handler(_node("post_je", inline))

    result = handler({"node_outputs": {}})
    assert result["node_outputs"]["post_je"]["action"] == "post_journal_entry"


# ---------------------------------------------------------------------------
# End to end through the real engine
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_registry_backed_node_runs_through_the_engine(client: AsyncClient):
    """
    A tool node carrying ONLY a tool_id runs to completion through _stream_graph —
    which is the whole point of the phase: the same graph would have raised
    ToolNodeConfigError before the registry existed.
    """
    from langgraph.types import Command

    from src.modules.executions.models import WorkflowRun
    from src.workers.graph_tasks import _stream_graph, initial_state_from_trigger

    ctx = await _ctx(client, "R-e2e")
    tool = await _make_tool(client, ctx, "post_je")
    wf = await create_workflow(client, ctx["token"], ctx["workspace_id"])

    nodes = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        NodeInput(node_key="approve", node_type=NodeType.human_approval, config={}, position_x=100, position_y=0),
        NodeInput(
            node_key="post_je",
            node_type=NodeType.tool,
            config={"tool_id": tool["id"], "payload": {"vendor": "Acme", "amount": 42, "account_code": "5000"}},
            position_x=200,
            position_y=0,
        ),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=300, position_y=0),
    ]
    edges = [
        EdgeInput(source_node_key="start", target_node_key="approve"),
        EdgeInput(source_node_key="approve", target_node_key="post_je"),
        EdgeInput(source_node_key="post_je", target_node_key="end"),
    ]
    payload = {"nodes": [n.model_dump(mode="json") for n in nodes], "edges": [e.model_dump(mode="json") for e in edges]}

    saved = await client.post(f"/api/v1/workflows/{wf['id']}/versions", json=payload, headers=ctx["headers"])
    assert saved.status_code == 201, saved.text
    version_id = saved.json()["id"]
    published = await client.post(f"/api/v1/workflows/{wf['id']}/versions/{version_id}/publish", headers=ctx["headers"])
    assert published.status_code == 200, published.text

    run = await client.post(f"/api/v1/workflows/{wf['id']}/run", json={"trigger_payload": {}}, headers=ctx["headers"])
    assert run.status_code == 201, run.text
    run_id = uuid.UUID(run.json()["id"])
    org_id = uuid.UUID(run.json()["organization_id"])

    async with async_session_maker() as db:
        from sqlalchemy import select

        version = (
            await db.execute(
                select(WorkflowVersion)
                .where(WorkflowVersion.id == uuid.UUID(version_id))
                .options(selectinload(WorkflowVersion.nodes), selectinload(WorkflowVersion.edges))
            )
        ).scalar_one()

    await _stream_graph(
        run_id,
        version,
        initial_state_from_trigger(organization_id=org_id, trigger_payload={}, run_id=str(run_id)),
        attempt=1,
        organization_id=org_id,
    )

    async with async_session_maker() as db:
        from sqlalchemy import select
        from sqlalchemy import update as sa_update

        stored = (await db.execute(select(WorkflowRun).where(WorkflowRun.id == run_id))).scalar_one()
        assert stored.status == "waiting_approval"
        await db.execute(sa_update(WorkflowRun).where(WorkflowRun.id == run_id).values(status="running", interrupt_payload=None))
        await db.commit()

    await _stream_graph(run_id, version, Command(resume={"decision": "approved"}), attempt=1, organization_id=org_id)

    async with async_session_maker() as db:
        from sqlalchemy import select

        stored = (
            await db.execute(select(WorkflowRun).where(WorkflowRun.id == run_id).options(selectinload(WorkflowRun.node_executions)))
        ).scalar_one()

    assert stored.status == "completed"
    tool_exec = next(ne for ne in stored.node_executions if ne.node_key == "post_je")
    assert tool_exec.status == "succeeded"
    posted = tool_exec.output["node_outputs"]["post_je"]
    assert posted["posted"] is True
    assert posted["confirmation_id"].startswith("MOCK-")
    assert posted["payload"] == {"vendor": "Acme", "amount": 42, "account_code": "5000"}
