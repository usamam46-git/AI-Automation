"""
tests/test_tool_executions.py — the Vol. 4 §4.3 audit trail.

The headline test is `test_intent_row_exists_before_the_call_goes_out`: it asserts
the ordering §4.3 actually requires ("logged to `tool_executions` *before*
execution, not after, so a crash mid-call still leaves an audit trail of intent")
by checking, from inside the patched HTTP boundary, that the row is already there
when the request fires. Everything else here is downstream of that.
"""

import uuid
from typing import Any
from unittest.mock import patch

import httpx
import pytest
from fastapi import status
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from src.db.database import async_session_maker
from src.db.sync_database import get_sync_session_maker
from src.graphs.node_handlers import ToolExecutionError, tool_handler
from src.modules.tools.models import ToolExecution
from src.modules.tools.service import ToolExecutionLogger
from src.modules.workflows.schemas import EdgeInput, NodeInput, NodeType
from tests.test_workflows import create_workflow, create_workspace, register_and_get_token


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
        "config": {"action": "create_journal_entry"},
        "is_mutating": True,
        **overrides,
    }
    resp = await client.post("/api/v1/tools", json=payload, headers=ctx["headers"])
    assert resp.status_code == status.HTTP_201_CREATED, resp.text
    return resp.json()


def _rows() -> list[ToolExecution]:
    """Read tool_executions through the sync engine the logger itself writes with."""
    with get_sync_session_maker()() as session:
        return list(session.execute(select(ToolExecution)).scalars().all())


ERP_CFG = {
    "tool_type": "erp_connector",
    "action": "create_journal_entry",
    "is_mutating": True,
    "payload": {"vendor": "Acme", "amount": 10, "account_code": "5000"},
}

HTTP_CFG = {
    "tool_type": "http_request",
    "url": "https://erp.test/vendors?api_key=hunter2",
    "method": "POST",
    "headers": {"Authorization": "Bearer super-secret"},
    "is_mutating": False,
}


# ---------------------------------------------------------------------------
# The ordering proof
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_intent_row_exists_before_the_call_goes_out(client: AsyncClient):
    """
    Vol. 4 §4.3 says *before*, not *after*. Asserting that from inside the HTTP
    boundary is the only way to prove it: by the time the handler returns, an
    after-the-fact write would look identical.
    """
    ctx = await _ctx(client, "TE-order")
    tool = await _make_tool(client, ctx, "call_erp", tool_type="http_request", config={"url": "https://erp.test/x", "method": "POST"})
    tool_id = uuid.UUID(tool["id"])

    seen_during_call: list[str] = []

    def _request(*_args, **_kwargs):
        rows = _rows()
        seen_during_call.extend(f"{r.status}:{r.tool_id}" for r in rows)
        return httpx.Response(200, json={"ok": True})

    mock = patch("src.graphs.node_handlers.httpx.Client")
    mock_client = mock.start()
    mock_client.return_value.request.side_effect = _request
    try:
        tool_handler(
            {},
            node_key="call_erp",
            config={"tool_type": "http_request", "url": "https://erp.test/x", "method": "POST", "is_mutating": False},
            tool_log=ToolExecutionLogger(),
            tool_id=tool_id,
        )
    finally:
        mock.stop()

    assert seen_during_call == [f"running:{tool_id}"], "intent row must be committed before the outbound call"

    # ...and it is finalized afterwards, in place — one row, not two.
    rows = _rows()
    assert len(rows) == 1
    assert rows[0].status == "succeeded"
    assert rows[0].output == {"status_code": 200, "body": {"ok": True}}
    assert rows[0].latency_ms >= 0


@pytest.mark.asyncio
async def test_a_failed_call_still_leaves_a_row(client: AsyncClient):
    """The crash-mid-call case §4.3 exists for: the intent survives the failure."""
    ctx = await _ctx(client, "TE-fail")
    tool = await _make_tool(client, ctx, "call_erp", tool_type="http_request", config={"url": "https://erp.test/x", "method": "POST"})

    mock = patch("src.graphs.node_handlers.httpx.Client")
    mock_client = mock.start()
    mock_client.return_value.request.side_effect = httpx.ConnectError("boom")
    try:
        with pytest.raises(ToolExecutionError):
            tool_handler(
                {},
                node_key="call_erp",
                config={"tool_type": "http_request", "url": "https://erp.test/x", "method": "POST", "is_mutating": False},
                tool_log=ToolExecutionLogger(),
                tool_id=uuid.UUID(tool["id"]),
                max_attempts=1,
                retry_base_delay=0,
            )
    finally:
        mock.stop()

    rows = _rows()
    assert len(rows) == 1
    assert rows[0].status == "failed"
    assert rows[0].output is None


# ---------------------------------------------------------------------------
# Redaction — this is a NEW leak surface
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_audit_input_carries_no_headers_and_no_query_string(client: AsyncClient):
    """
    `tools.config` legitimately holds an Authorization bearer token, and `?api_key=`
    is a common auth pattern. Neither may reach a row an operator reads back — the
    same rule that keeps headers out of node_executions.output.
    """
    ctx = await _ctx(client, "TE-redact")
    tool = await _make_tool(client, ctx, "call_erp", tool_type="http_request", config={"url": "https://erp.test/x", "method": "POST"})

    mock = patch("src.graphs.node_handlers.httpx.Client")
    mock_client = mock.start()
    mock_client.return_value.request.return_value = httpx.Response(200, json={"ok": True})
    try:
        tool_handler({}, node_key="call_erp", config=HTTP_CFG, tool_log=ToolExecutionLogger(), tool_id=uuid.UUID(tool["id"]))
    finally:
        mock.stop()

    recorded = _rows()[0].input
    serialized = str(recorded)
    assert "headers" not in recorded
    assert "super-secret" not in serialized
    assert "hunter2" not in serialized
    assert recorded["url"] == "https://erp.test/vendors?<redacted>"
    assert recorded["method"] == "POST"


# ---------------------------------------------------------------------------
# When logging is (and isn't) wired
# ---------------------------------------------------------------------------


def test_no_logger_means_no_rows_and_no_extra_state():
    """
    The default path — inline config, or any DB-less compile. Both new parameters
    default to None and the handler must behave exactly as it did pre-registry.
    """
    result = tool_handler({}, node_key="post_je", config=ERP_CFG)

    assert set(result) == {"node_outputs"}
    assert result["node_outputs"]["post_je"]["posted"] is True
    assert _rows() == []


@pytest.mark.asyncio
async def test_tool_id_without_a_logger_writes_nothing(client: AsyncClient):
    ctx = await _ctx(client, "TE-nolog")
    tool = await _make_tool(client, ctx, "post_je")

    tool_handler({}, node_key="post_je", config=ERP_CFG, tool_id=uuid.UUID(tool["id"]))
    assert _rows() == []


@pytest.mark.asyncio
async def test_execution_ids_ride_back_on_node_tool_calls(client: AsyncClient):
    ctx = await _ctx(client, "TE-channel")
    tool = await _make_tool(client, ctx, "post_je")

    result = tool_handler({}, node_key="post_je", config=ERP_CFG, tool_log=ToolExecutionLogger(), tool_id=uuid.UUID(tool["id"]))

    assert list(result["node_tool_calls"]) == ["post_je"]
    assert result["node_tool_calls"]["post_je"] == [str(_rows()[0].id)]


def test_output_snapshot_strips_the_bookkeeping_channel():
    """`node_tool_calls` is transport, not output — it must not reach the Viewer."""
    from src.workers.graph_tasks import _output_snapshot

    snapshot = _output_snapshot({"node_outputs": {"a": 1}, "node_usage": {"a": {}}, "node_tool_calls": {"a": ["x"]}})
    assert snapshot == {"node_outputs": {"a": 1}}


# ---------------------------------------------------------------------------
# End to end: back-fill of node_execution_id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_node_execution_id_is_backfilled_after_the_superstep(client: AsyncClient):
    """
    The FK cannot be set at intent time — node_executions rows are only inserted
    after the superstep yields. This proves the window closes.
    """
    from langgraph.types import Command

    from src.modules.executions.models import WorkflowRun
    from src.modules.workflows.models import WorkflowVersion
    from src.workers.graph_tasks import _stream_graph, initial_state_from_trigger

    ctx = await _ctx(client, "TE-e2e")
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
    assert (await client.post(f"/api/v1/workflows/{wf['id']}/versions/{version_id}/publish", headers=ctx["headers"])).status_code == 200

    run = await client.post(f"/api/v1/workflows/{wf['id']}/run", json={"trigger_payload": {}}, headers=ctx["headers"])
    assert run.status_code == 201, run.text
    run_id = uuid.UUID(run.json()["id"])
    org_id = uuid.UUID(run.json()["organization_id"])

    async with async_session_maker() as db:
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

    # Nothing has called the tool yet — the approval gate is still pending.
    assert _rows() == []

    async with async_session_maker() as db:
        from sqlalchemy import update as sa_update

        await db.execute(sa_update(WorkflowRun).where(WorkflowRun.id == run_id).values(status="running", interrupt_payload=None))
        await db.commit()

    await _stream_graph(run_id, version, Command(resume={"decision": "approved"}), attempt=1, organization_id=org_id)

    async with async_session_maker() as db:
        stored = (
            await db.execute(select(WorkflowRun).where(WorkflowRun.id == run_id).options(selectinload(WorkflowRun.node_executions)))
        ).scalar_one()
    assert stored.status == "completed"
    node_exec = next(ne for ne in stored.node_executions if ne.node_key == "post_je")

    rows = _rows()
    assert len(rows) == 1
    assert rows[0].status == "succeeded"
    assert rows[0].tool_id == uuid.UUID(tool["id"])
    assert rows[0].node_execution_id == node_exec.id
    assert rows[0].input["action"] == "create_journal_entry"
    assert rows[0].input["is_mutating"] is True
    assert rows[0].output["confirmation_id"].startswith("MOCK-")

    # The bookkeeping channel stayed out of the rendered node output.
    assert "node_tool_calls" not in node_exec.output
