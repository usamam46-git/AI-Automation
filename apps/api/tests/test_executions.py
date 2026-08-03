"""
tests/test_executions.py — Integration tests for the execution engine.

Covers:
  a. Happy path: publish start→condition→human_approval→end, trigger run,
     confirm waiting_approval + interrupt_payload, approve, confirm completed
     with node_executions rows.
  b. Reject path: same graph, resume with rejected → status=rejected, no
     further graph execution.
  c. Cross-tenant isolation: Org A cannot fetch or resume Org B's run (404).
  d. Worker-restart simulation: after waiting_approval, a FRESH compile+resume
     (new PostgresSaver instance, no in-memory state) restores from the Postgres
     checkpoint and completes the run.
  e. Two human_approval nodes: covered in test_celery_tasks.py.

Integration strategy:
  - Celery tasks are NOT invoked via the broker in these tests. Instead,
    _stream_graph() is called directly (async) to exercise the real execution
    path including PostgresSaver writes, without needing a running Celery worker.
  - HTTP endpoints are tested for permission scoping and status transitions.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from src.db.database import async_session_maker
from src.graphs.compiler import initial_state_from_trigger
from src.modules.executions.models import WorkflowRun
from src.modules.workflows.models import WorkflowVersion
from src.workers.graph_tasks import _stream_graph

# ---------------------------------------------------------------------------
# Re-use helpers from test_workflow_versions (same pattern as other test files)
# ---------------------------------------------------------------------------


async def _register_and_publish(client: AsyncClient, tag: str) -> dict[str, Any]:
    """
    Register a user, create workspace + workflow, save and publish a
    start→condition→human_approval→end graph.
    Returns {token, workflow_id, version_id, headers}.
    """
    from test_workflow_versions import (
        create_workflow,
        create_workspace,
        graph_payload,
        register_and_get_token,
    )

    from src.modules.workflows.schemas import EdgeInput, NodeInput, NodeType

    data = await register_and_get_token(client, f"exec-{tag}")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"])

    # start → condition → human_approval → end
    nodes = [
        NodeInput(node_key="start", node_type=NodeType.start, config={}, position_x=0, position_y=0),
        NodeInput(node_key="route", node_type=NodeType.condition, config={}, position_x=100, position_y=0),
        NodeInput(node_key="human_approval", node_type=NodeType.human_approval, config={}, position_x=200, position_y=0),
        NodeInput(node_key="end", node_type=NodeType.end, config={}, position_x=300, position_y=0),
    ]
    edges = [
        EdgeInput(source_node_key="start", target_node_key="route"),
        EdgeInput(
            source_node_key="route",
            target_node_key="human_approval",
            condition={"field": "trigger_payload.approve", "operator": "eq", "value": True, "branch": "approve"},
        ),
        EdgeInput(source_node_key="human_approval", target_node_key="end"),
    ]

    saved = await client.post(
        f"/api/v1/workflows/{wf['id']}/versions",
        json=graph_payload(nodes, edges),
        headers=headers,
    )
    assert saved.status_code == 201
    version_id = saved.json()["id"]

    published = await client.post(
        f"/api/v1/workflows/{wf['id']}/versions/{version_id}/publish",
        headers=headers,
    )
    assert published.status_code == 200

    return {
        "token": token,
        "headers": headers,
        "workflow_id": wf["id"],
        "version_id": version_id,
        "org_id": data.get("org_id"),  # may be None depending on registration shape
    }


async def _load_run_with_executions(run_id: uuid.UUID) -> WorkflowRun:
    async with async_session_maker() as session:
        stmt = select(WorkflowRun).where(WorkflowRun.id == run_id).options(selectinload(WorkflowRun.node_executions))
        result = await session.execute(stmt)
        return result.scalar_one()


async def _load_version(version_id: uuid.UUID) -> WorkflowVersion:
    from src.modules.workflows.models import WorkflowVersion

    async with async_session_maker() as session:
        stmt = (
            select(WorkflowVersion)
            .where(WorkflowVersion.id == uuid.UUID(version_id))
            .options(
                selectinload(WorkflowVersion.nodes),
                selectinload(WorkflowVersion.edges),
            )
        )
        result = await session.execute(stmt)
        return result.scalar_one()


# ---------------------------------------------------------------------------
# a. Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_happy_path_full_run(client: AsyncClient):
    """
    Trigger → waiting_approval (with interrupt_payload) → approve → completed
    with node_executions rows for every non-condition node.
    """
    ctx = await _register_and_publish(client, "happy")
    headers = ctx["headers"]
    workflow_id = ctx["workflow_id"]
    version_id = ctx["version_id"]

    # Trigger run via HTTP (task is NOT auto-dispatched in tests)
    resp = await client.post(
        f"/api/v1/workflows/{workflow_id}/run",
        json={"trigger_payload": {"approve": True}},
        headers=headers,
    )
    assert resp.status_code == 201
    run_data = resp.json()
    run_id = uuid.UUID(run_data["id"])
    assert run_data["status"] == "pending"

    # Manually drive execution (replaces Celery worker for test purposes)
    version = await _load_version(version_id)
    initial_state = initial_state_from_trigger(
        organization_id=uuid.UUID(run_data["organization_id"]),
        trigger_payload={"approve": True},
        run_id=str(run_id),
    )

    # First stream — should pause at human_approval
    await _stream_graph(run_id, version, initial_state, attempt=1)

    run = await _load_run_with_executions(run_id)
    assert run.status == "waiting_approval"
    assert run.interrupt_payload is not None
    assert run.interrupt_payload.get("type") == "approval_request"

    # Poll via HTTP
    poll_resp = await client.get(f"/api/v1/executions/{run_id}", headers=headers)
    assert poll_resp.status_code == 200
    assert poll_resp.json()["status"] == "waiting_approval"
    assert poll_resp.json()["interrupt_payload"] is not None

    # Update status to running (as service.resume_run does for approved)
    async with async_session_maker() as session:
        from sqlalchemy import update as sa_update

        await session.execute(sa_update(WorkflowRun).where(WorkflowRun.id == run_id).values(status="running", interrupt_payload=None))
        await session.commit()

    # Resume stream (replaces Celery resume_workflow task)
    from langgraph.types import Command

    await _stream_graph(run_id, version, Command(resume={"decision": "approved"}), attempt=1)

    run = await _load_run_with_executions(run_id)
    assert run.status == "completed"
    assert run.completed_at is not None

    # Should have node_executions for start and human_approval (end is a no-op in LangGraph)
    node_keys_executed = {ne.node_key for ne in run.node_executions}
    assert "start" in node_keys_executed
    assert "human_approval" in node_keys_executed
    for ne in run.node_executions:
        assert ne.status == "succeeded"


# ---------------------------------------------------------------------------
# b. Reject path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reject_path(client: AsyncClient):
    """
    Trigger → waiting_approval → reject → status=rejected (terminal, no further execution).
    """
    ctx = await _register_and_publish(client, "reject")
    headers = ctx["headers"]
    workflow_id = ctx["workflow_id"]
    version_id = ctx["version_id"]

    resp = await client.post(
        f"/api/v1/workflows/{workflow_id}/run",
        json={"trigger_payload": {"approve": True}},
        headers=headers,
    )
    run_id = uuid.UUID(resp.json()["id"])

    # Drive to waiting_approval
    version = await _load_version(version_id)
    initial_state = initial_state_from_trigger(
        organization_id=uuid.UUID(resp.json()["organization_id"]),
        trigger_payload={"approve": True},
        run_id=str(run_id),
    )
    await _stream_graph(run_id, version, initial_state, attempt=1)

    # Update to waiting_approval directly (stream already did this, confirm)
    run = await _load_run_with_executions(run_id)
    assert run.status == "waiting_approval"

    # Reject via HTTP endpoint
    reject_resp = await client.post(
        f"/api/v1/executions/{run_id}/resume",
        json={"decision": "rejected", "comment": "Duplicate invoice"},
        headers=headers,
    )
    assert reject_resp.status_code == 200
    data = reject_resp.json()
    assert data["status"] == "rejected"
    assert data["completed_at"] is not None
    assert data["error"]["comment"] == "Duplicate invoice"

    # Confirm no further node_executions were written after rejection
    run = await _load_run_with_executions(run_id)
    node_keys_after_reject = {ne.node_key for ne in run.node_executions}
    assert "end" not in node_keys_after_reject  # graph never continued past human_approval


# ---------------------------------------------------------------------------
# c. Cross-tenant isolation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cross_tenant_run_isolation(client: AsyncClient):
    """Org A cannot fetch or resume Org B's run — 404 in both cases."""
    ctx_a = await _register_and_publish(client, "tenant-a")
    ctx_b = await _register_and_publish(client, "tenant-b")

    headers_a = ctx_a["headers"]
    headers_b = ctx_b["headers"]
    workflow_id_b = ctx_b["workflow_id"]

    # Create a run in Org B
    resp = await client.post(
        f"/api/v1/workflows/{workflow_id_b}/run",
        json={"trigger_payload": {"approve": True}},
        headers=headers_b,
    )
    assert resp.status_code == 201
    run_id = resp.json()["id"]

    # Org A tries to GET Org B's run — must 404
    get_resp = await client.get(f"/api/v1/executions/{run_id}", headers=headers_a)
    assert get_resp.status_code == 404

    # Org A tries to resume Org B's run — must 404
    resume_resp = await client.post(
        f"/api/v1/executions/{run_id}/resume",
        json={"decision": "approved"},
        headers=headers_a,
    )
    assert resume_resp.status_code == 404


# ---------------------------------------------------------------------------
# d. Worker-restart simulation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_worker_restart_restores_from_checkpoint(client: AsyncClient):
    """
    After waiting_approval, a completely fresh PostgresSaver (no in-memory state)
    must restore from the Postgres checkpoint and complete the run.
    """
    ctx = await _register_and_publish(client, "restart")
    headers = ctx["headers"]
    workflow_id = ctx["workflow_id"]
    version_id = ctx["version_id"]

    resp = await client.post(
        f"/api/v1/workflows/{workflow_id}/run",
        json={"trigger_payload": {"approve": True}},
        headers=headers,
    )
    run_id = uuid.UUID(resp.json()["id"])
    org_id = uuid.UUID(resp.json()["organization_id"])

    version = await _load_version(version_id)
    initial_state = initial_state_from_trigger(
        organization_id=org_id,
        trigger_payload={"approve": True},
        run_id=str(run_id),
    )

    # FIRST worker instance: stream until interrupt
    await _stream_graph(run_id, version, initial_state, attempt=1)

    run = await _load_run_with_executions(run_id)
    assert run.status == "waiting_approval"

    # Simulate worker restart: set status to running (as service does on approval)
    async with async_session_maker() as session:
        from sqlalchemy import update as sa_update

        await session.execute(sa_update(WorkflowRun).where(WorkflowRun.id == run_id).values(status="running", interrupt_payload=None))
        await session.commit()

    # SECOND worker instance (fresh — does not share any in-memory compiled graph
    # or saver state with the first instance). Uses a new PostgresSaver.
    from langgraph.types import Command

    version2 = await _load_version(version_id)  # fresh load from DB
    await _stream_graph(run_id, version2, Command(resume={"decision": "approved"}), attempt=1)

    run = await _load_run_with_executions(run_id)
    assert run.status == "completed", f"Expected completed, got {run.status}"
    assert run.completed_at is not None


# ---------------------------------------------------------------------------
# Version-pinning via HTTP endpoint (supplement to test_celery_tasks.py unit test)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_trigger_run_requires_workflow_execute_permission(client: AsyncClient):
    """
    POST /run requires workflow:execute. A user holding the seeded Editor
    role (workflow:write but NOT workflow:execute — see seed_roles.py) must
    get 403, proving the permission check actually discriminates rather than
    just requiring *some* authenticated user.
    """
    from sqlalchemy import update as sa_update
    from test_workflow_versions import create_workflow, create_workspace, register_and_get_token

    from src.core.cache import invalidate_permissions_cache
    from src.core.redis import get_redis
    from src.core.security import decode_access_token
    from src.modules.auth.models import OrgMembership, Role

    data = await register_and_get_token(client, "perm-check")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    claims = decode_access_token(token)
    user_id = uuid.UUID(claims["user_id"])
    org_id = uuid.UUID(claims["org_id"])

    ws = await create_workspace(client, token)
    wf = await create_workflow(client, token, ws["id"])

    # Downgrade the registering user from Owner (seeded with "*") to Editor,
    # the only system role that isolates workflow:write without workflow:execute.
    async with async_session_maker() as session:
        editor_role = (
            (
                await session.execute(select(Role).where(Role.name == "Editor", Role.is_system == True))  # noqa: E712
            )
            .scalars()
            .first()
        )
        assert editor_role is not None, "Editor system role must be seeded"

        await session.execute(
            sa_update(OrgMembership).where(OrgMembership.user_id == user_id, OrgMembership.organization_id == org_id).values(role_id=editor_role.id)
        )
        await session.commit()

    # The permission-check dependency caches resolved permissions in Redis;
    # the cache entry populated under Owner during setup above must be evicted
    # or this test would pass against stale "*" permissions.
    redis = await get_redis()
    await invalidate_permissions_cache(redis, str(org_id), str(user_id))

    resp = await client.post(
        f"/api/v1/workflows/{wf['id']}/run",
        json={"trigger_payload": {}},
        headers=headers,
    )
    assert resp.status_code == 403
    assert "workflow:execute" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_trigger_run_requires_authentication(client: AsyncClient):
    """POST /run without a token returns 401 — distinct from the 403
    permission-denied case covered above; both are real, separate behaviors."""
    resp = await client.post("/api/v1/workflows/00000000-0000-0000-0000-000000000001/run", json={})
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_resume_requires_waiting_approval_status(client: AsyncClient):
    """Resuming a run that is not waiting_approval returns 409."""
    ctx = await _register_and_publish(client, "status-check")
    headers = ctx["headers"]
    workflow_id = ctx["workflow_id"]

    # Create a run (stays in pending since no worker)
    resp = await client.post(
        f"/api/v1/workflows/{workflow_id}/run",
        json={},
        headers=headers,
    )
    run_id = resp.json()["id"]

    # Try to resume immediately (status is still pending)
    resume_resp = await client.post(
        f"/api/v1/executions/{run_id}/resume",
        json={"decision": "approved"},
        headers=headers,
    )
    assert resume_resp.status_code == 409
    assert "waiting_approval" in resume_resp.json()["detail"]
