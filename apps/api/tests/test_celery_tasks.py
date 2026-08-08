"""
tests/test_celery_tasks.py — Unit tests for PostgresSaver and graph task helpers.

Scope:
  - PostgresSaver.aput() / aget_tuple() round-trip correctness (real test DB)
  - aput_writes() stores pending_writes returned by aget_tuple()
  - Idempotency check: _insert_node_execution skips a row that already succeeded
  - Version-pinning: trigger_run raises 422 when workflow has no published version
  - Bug-fix (e): two human_approval nodes in the same graph key decisions independently
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient

from src.db.database import async_session_maker
from src.graphs.compiler import (
    compile_for_test_run,
    initial_state_from_trigger,
    run_graph_sync,
)
from src.modules.workflows.models import WorkflowEdge, WorkflowNode, WorkflowVersion
from src.workers.postgres_saver import PostgresSaver

# ---------------------------------------------------------------------------
# Helpers — lightweight ORM-shaped objects (no DB, for in-process graph tests)
# ---------------------------------------------------------------------------


def _node(key: str, node_type: str) -> WorkflowNode:
    return WorkflowNode(
        id=uuid.uuid4(),
        workflow_version_id=uuid.uuid4(),
        node_key=key,
        node_type=node_type,
        config={},
        position_x=0.0,
        position_y=0.0,
    )


def _edge(source: str, target: str, condition: dict | None = None) -> WorkflowEdge:
    return WorkflowEdge(
        id=uuid.uuid4(),
        workflow_version_id=uuid.uuid4(),
        source_node_key=source,
        target_node_key=target,
        condition=condition,
    )


def _published_version(nodes: list[WorkflowNode], edges: list[WorkflowEdge]) -> WorkflowVersion:
    version = WorkflowVersion(
        id=uuid.uuid4(),
        workflow_id=uuid.uuid4(),
        version_number=1,
        graph_definition={},
        published_at=datetime.now(UTC),
    )
    version.nodes = nodes
    version.edges = edges
    return version


def _two_approval_version() -> WorkflowVersion:
    """start → approve_one → approve_two → end (two sequential human_approval nodes)."""
    nodes = [
        _node("start", "start"),
        _node("approve_one", "human_approval"),
        _node("approve_two", "human_approval"),
        _node("end", "end"),
    ]
    edges = [
        _edge("start", "approve_one"),
        _edge("approve_one", "approve_two"),
        _edge("approve_two", "end"),
    ]
    return _published_version(nodes, edges)


async def _create_real_run(client: AsyncClient) -> dict:
    """
    Create a real org + published workflow + pending WorkflowRun via the HTTP API.
    Returns {"run_id": UUID, "org_id": UUID, "version_id": str}.
    All FK constraints are satisfied because the full chain is created properly.
    """
    from test_workflow_versions import graph_payload, register_and_get_token
    from test_workflows import create_workflow, create_workspace

    from src.modules.workflows.schemas import EdgeInput, NodeInput, NodeType

    data = await register_and_get_token(client, f"saver-{uuid.uuid4().hex[:6]}")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"])

    nodes = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=100, position_y=0),
    ]
    edges = [EdgeInput(source_node_key="start", target_node_key="end")]

    saved = await client.post(
        f"/api/v1/workflows/{wf['id']}/versions",
        json=graph_payload(nodes, edges),
        headers=headers,
    )
    assert saved.status_code == 201
    version_id = saved.json()["id"]

    await client.post(
        f"/api/v1/workflows/{wf['id']}/versions/{version_id}/publish",
        headers=headers,
    )

    resp = await client.post(
        f"/api/v1/workflows/{wf['id']}/run",
        json={"trigger_payload": {}},
        headers=headers,
    )
    assert resp.status_code == 201
    run_data = resp.json()
    return {
        "run_id": uuid.UUID(run_data["id"]),
        "org_id": uuid.UUID(run_data["organization_id"]),
        "version_id": version_id,
    }


# ---------------------------------------------------------------------------
# PostgresSaver — round-trip tests (real test DB)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_postgres_saver_put_get_roundtrip(client: AsyncClient):
    """aput() stores a checkpoint; aget_tuple() retrieves it correctly."""
    ctx = await _create_real_run(client)
    run_id = ctx["run_id"]

    saver = PostgresSaver(async_session_maker)
    thread_id = str(run_id)
    config = {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}

    from langgraph.checkpoint.base import empty_checkpoint

    checkpoint = empty_checkpoint()
    checkpoint["id"] = "ts-001"
    metadata = {"source": "input", "step": 0, "writes": None, "parents": {}}

    returned_config = await saver.aput(config, checkpoint, metadata, {})

    assert returned_config["configurable"]["checkpoint_id"] == "ts-001"
    assert returned_config["configurable"]["thread_id"] == thread_id

    tuple_ = await saver.aget_tuple(returned_config)
    assert tuple_ is not None
    assert tuple_.checkpoint["id"] == "ts-001"
    assert tuple_.metadata["source"] == "input"
    assert tuple_.config["configurable"]["checkpoint_id"] == "ts-001"
    assert not tuple_.pending_writes  # empty


@pytest.mark.asyncio
async def test_postgres_saver_put_writes_stored_and_returned(client: AsyncClient):
    """aput_writes() appends pending writes; aget_tuple() returns them."""
    ctx = await _create_real_run(client)
    run_id = ctx["run_id"]

    saver = PostgresSaver(async_session_maker)
    thread_id = str(run_id)

    from langgraph.checkpoint.base import empty_checkpoint

    checkpoint = empty_checkpoint()
    checkpoint["id"] = "ts-002"
    config = {"configurable": {"thread_id": thread_id, "checkpoint_ns": "", "checkpoint_id": "ts-002"}}

    await saver.aput(config, checkpoint, {"source": "loop", "step": 1, "writes": None, "parents": {}}, {})

    interrupt_value = {"type": "approval_request", "node_outputs": {}}
    await saver.aput_writes(config, [("__interrupt__", interrupt_value)], task_id="task-abc")

    tuple_ = await saver.aget_tuple(config)
    assert tuple_ is not None
    assert tuple_.pending_writes is not None
    assert len(tuple_.pending_writes) == 1
    task_id_ret, channel, value = tuple_.pending_writes[0]
    assert task_id_ret == "task-abc"
    assert channel == "__interrupt__"
    assert value == interrupt_value


@pytest.mark.asyncio
async def test_postgres_saver_aput_clears_pending_writes(client: AsyncClient):
    """A subsequent aput() resets pending_writes from the previous checkpoint."""
    ctx = await _create_real_run(client)
    run_id = ctx["run_id"]

    saver = PostgresSaver(async_session_maker)
    thread_id = str(run_id)

    from langgraph.checkpoint.base import empty_checkpoint

    cp1 = empty_checkpoint()
    cp1["id"] = "ts-003a"
    config_a = {"configurable": {"thread_id": thread_id, "checkpoint_ns": "", "checkpoint_id": "ts-003a"}}
    await saver.aput(config_a, cp1, {"source": "loop", "step": 0, "writes": None, "parents": {}}, {})
    await saver.aput_writes(config_a, [("__interrupt__", {"x": 1})], task_id="t1")

    cp2 = empty_checkpoint()
    cp2["id"] = "ts-003b"
    config_b = {"configurable": {"thread_id": thread_id, "checkpoint_ns": "", "checkpoint_id": "ts-003a"}}
    await saver.aput(config_b, cp2, {"source": "loop", "step": 1, "writes": None, "parents": {}}, {})

    tuple_ = await saver.aget_tuple({"configurable": {"thread_id": thread_id}})
    assert tuple_ is not None
    assert not tuple_.pending_writes  # cleared by aput()


@pytest.mark.asyncio
async def test_postgres_saver_missing_run_returns_none():
    """aget_tuple() returns None for a thread_id with no matching run."""
    saver = PostgresSaver(async_session_maker)
    config = {"configurable": {"thread_id": str(uuid.uuid4()), "checkpoint_ns": ""}}
    result = await saver.aget_tuple(config)
    assert result is None


# ---------------------------------------------------------------------------
# Idempotency check
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_insert_node_execution_idempotency(client: AsyncClient):
    """
    _insert_node_execution returns the new row's id, or None when it skipped
    because a succeeded row already exists for (run, node_key, attempt).

    It returned a bool until the tools module landed; the id is what
    `_stream_graph` back-fills `tool_executions.node_execution_id` with, and a
    None return is the signal that there is nothing to back-fill.
    """
    from src.workers.graph_tasks import _insert_node_execution

    ctx = await _create_real_run(client)
    run_id = ctx["run_id"]

    inserted = await _insert_node_execution(
        workflow_run_id=run_id,
        node_key="start",
        status="succeeded",
        input_snapshot=None,
        output_snapshot={},
        latency_ms=5,
        attempt=1,
    )
    assert isinstance(inserted, uuid.UUID)

    inserted_again = await _insert_node_execution(
        workflow_run_id=run_id,
        node_key="start",
        status="succeeded",
        input_snapshot=None,
        output_snapshot={"x": 2},
        latency_ms=3,
        attempt=1,
    )
    assert inserted_again is None


# ---------------------------------------------------------------------------
# Version-pinning: trigger_run rejects workflows without a published version
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_trigger_run_rejects_unpublished_workflow(client: AsyncClient):
    from test_workflow_versions import register_and_get_token
    from test_workflows import create_workflow, create_workspace

    data = await register_and_get_token(client, "exec-noversion")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"])

    resp = await client.post(
        f"/api/v1/workflows/{wf['id']}/run",
        json={},
        headers=headers,
    )
    assert resp.status_code == 422
    assert "no published version" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# Bug-fix (e): two human_approval nodes — no key collision
# ---------------------------------------------------------------------------


def test_two_human_approval_nodes_use_separate_keys():
    """
    A graph with two sequential human_approval nodes must store their decisions
    under their respective node_keys — not both under the fixed 'human_approval'
    key. Verifies the bug fix in human_approval_handler and the compiler closure.
    """
    version = _two_approval_version()
    compiled = compile_for_test_run(version)
    state = initial_state_from_trigger(organization_id=uuid.uuid4())

    # First stream — pauses at approve_one
    run_graph_sync(compiled, state, thread_id="two-approval-run")
    graph_state = compiled.get_state({"configurable": {"thread_id": "two-approval-run"}})
    assert graph_state.next == ("approve_one",)

    # Resume approve_one

    run_graph_sync(compiled, state, thread_id="two-approval-run", resume={"decision": "approved", "node": "approve_one"})

    # Should now be paused at approve_two
    graph_state = compiled.get_state({"configurable": {"thread_id": "two-approval-run"}})
    assert graph_state.next == ("approve_two",)

    # approve_one's decision is keyed by its node_key
    node_outputs = graph_state.values.get("node_outputs", {})
    assert "approve_one" in node_outputs, f"Expected 'approve_one' in node_outputs; got {list(node_outputs.keys())}"
    assert "approve_two" not in node_outputs, "approve_two should not have run yet"

    # Resume approve_two
    run_graph_sync(compiled, state, thread_id="two-approval-run", resume={"decision": "approved", "node": "approve_two"})

    final_state = compiled.get_state({"configurable": {"thread_id": "two-approval-run"}})
    final_outputs = final_state.values.get("node_outputs", {})
    assert "approve_one" in final_outputs, "approve_one key missing from final state"
    assert "approve_two" in final_outputs, "approve_two key missing from final state"
