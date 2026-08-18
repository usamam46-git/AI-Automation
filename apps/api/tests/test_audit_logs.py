"""
tests/test_audit_logs.py — the append-only audit trail (Vol. 2 §3.5, §13 §700).

§700 asks for two independent controls, and this file pins both:
  1. no UPDATE/DELETE route exists at the application layer;
  2. the database rejects UPDATE/DELETE outright.

Plus the part that was missing entirely until 2026-08-09 — that material
actions actually write a row.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text, update

from src.core.permissions import AUDIT_READ, BILLING_READ, INTEGRATION_READ, permission_granted
from src.db.database import async_session_maker
from src.modules.audit_logs.models import AuditLog
from src.modules.audit_logs.service import AuditAction
from src.modules.auth.models import User


async def _logs_for_org(organization_id: uuid.UUID, action: str | None = None) -> list[AuditLog]:
    async with async_session_maker() as session:
        stmt = select(AuditLog).where(AuditLog.organization_id == organization_id)
        if action is not None:
            stmt = stmt.where(AuditLog.action == action)
        return list((await session.execute(stmt)).scalars().all())


async def _any_log() -> AuditLog:
    async with async_session_maker() as session:
        row = (await session.execute(select(AuditLog).limit(1))).scalar_one_or_none()
    assert row is not None, "expected at least one audit row"
    return row


# ---------------------------------------------------------------------------
# 1. Database-layer immutability
# ---------------------------------------------------------------------------


async def test_update_on_audit_logs_is_rejected_by_the_database(client: AsyncClient):
    """
    The control §700 asks for and that no migration actually created until
    2026-08-09. Bypasses the application entirely — this is raw SQL against the
    table, which is exactly the threat model (a compromised service, or someone
    at a psql prompt, quietly rewriting history).
    """
    from test_executions import _register_and_publish

    await _register_and_publish(client, "audit-update")
    row = await _any_log()

    async with async_session_maker() as session:
        with pytest.raises(Exception) as exc:
            await session.execute(update(AuditLog).where(AuditLog.id == row.id).values(action="tampered"))
            await session.commit()
    assert "append-only" in str(exc.value)

    # And the row is untouched.
    async with async_session_maker() as session:
        unchanged = (await session.execute(select(AuditLog).where(AuditLog.id == row.id))).scalar_one()
    assert unchanged.action != "tampered"


async def test_delete_on_audit_logs_is_rejected_by_the_database(client: AsyncClient):
    from test_executions import _register_and_publish

    await _register_and_publish(client, "audit-delete")
    row = await _any_log()

    async with async_session_maker() as session:
        with pytest.raises(Exception) as exc:
            await session.execute(text("DELETE FROM audit_logs WHERE id = :id"), {"id": str(row.id)})
            await session.commit()
    assert "append-only" in str(exc.value)


async def test_truncate_still_works(client: AsyncClient):
    """
    Deliberate, and load-bearing for the test suite itself: PostgreSQL fires
    TRUNCATE triggers — not row-level UPDATE/DELETE ones — on a TRUNCATE, so
    conftest's `_clean_database` fixture still works. If someone "hardens" this
    by adding a TRUNCATE trigger, every test in the repo starts failing at
    teardown. §700 names UPDATE and DELETE only.
    """
    from test_executions import _register_and_publish

    await _register_and_publish(client, "audit-truncate")

    async with async_session_maker() as session:
        await session.execute(text("TRUNCATE TABLE audit_logs"))
        await session.commit()
        remaining = (await session.execute(select(AuditLog))).scalars().all()
    assert list(remaining) == []


# ---------------------------------------------------------------------------
# 2. No mutating route exists
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("method", ["post", "patch", "put", "delete"])
async def test_no_mutating_route_on_audit_logs(client: AsyncClient, method: str):
    """§700: 'no UPDATE/DELETE route exists'. 405, not 401 — the route is absent."""
    from test_workflow_versions import register_and_get_token

    data = await register_and_get_token(client, f"audit-verb-{method}")
    headers = {"Authorization": f"Bearer {data['access_token']}"}

    # client.request(), not client.delete() — httpx's delete() takes no `json`.
    resp = await client.request(method.upper(), "/api/v1/audit-logs", headers=headers, json={})
    assert resp.status_code == 405, f"{method.upper()} /audit-logs should not exist, got {resp.status_code}"


# ---------------------------------------------------------------------------
# 3. Material actions write rows
# ---------------------------------------------------------------------------


async def test_publish_writes_an_audit_row(client: AsyncClient):
    from test_executions import _register_and_publish

    ctx = await _register_and_publish(client, "audit-publish")

    resp = await client.get("/api/v1/audit-logs?action=workflow.published", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["resource_type"] == "workflow_version"
    assert rows[0]["resource_id"] == ctx["version_id"]
    assert rows[0]["actor_type"] == "user"
    assert rows[0]["actor_id"] is not None
    assert rows[0]["metadata"]["workflow_id"] == ctx["workflow_id"]


async def test_actor_email_is_resolved_for_a_user_row(client: AsyncClient):
    """
    `actor_id` is a bare UUID and there is no endpoint that resolves one to a
    person, so the viewer would render hex strings without this join. Added
    2026-08-18 with the audit-log UI.
    """
    from test_executions import _register_and_publish

    ctx = await _register_and_publish(client, "audit-actor-email")

    resp = await client.get("/api/v1/audit-logs?action=workflow.published", headers=ctx["headers"])
    rows = resp.json()
    assert len(rows) == 1, "the LEFT JOIN to users must not multiply rows"

    async with async_session_maker() as session:
        expected = (await session.execute(select(User.email).where(User.id == uuid.UUID(rows[0]["actor_id"])))).scalar_one()
    assert rows[0]["actor_email"] == expected


async def test_system_actor_rows_carry_no_actor_email(client: AsyncClient):
    """
    The join is guarded on `actor_type == 'user'` because `actor_id` is
    polymorphic (models.py: users.id OR agent_sessions.id). A system row has a
    null actor_id and must resolve to null, not to whatever user shares the id.
    """
    from test_trigger_schedule import _dispatch_due_schedules_async, _force_due, _scheduled_published_workflow

    ctx = await _scheduled_published_workflow(client, "audit-sys-email")
    await _force_due(ctx["workflow_id"])
    await _dispatch_due_schedules_async()

    logs = await client.get(f"/api/v1/audit-logs?action={AuditAction.WORKFLOW_RUN_STARTED}", headers=ctx["headers"])
    rows = logs.json()
    assert len(rows) == 1
    assert rows[0]["actor_type"] == "system"
    assert rows[0]["actor_email"] is None


async def test_manual_run_and_approval_are_audited(client: AsyncClient):
    """
    The approval pair is the most compliance-relevant thing the product does —
    a human authorizing a mutating write. Who decided, and what they said.
    """
    from test_executions import _register_and_publish, _trigger

    ctx = await _register_and_publish(client, "audit-approve")
    run_id = await _trigger(client, ctx["headers"], ctx["workflow_id"])

    async with async_session_maker() as session:
        from src.modules.executions.models import WorkflowRun

        await session.execute(update(WorkflowRun).where(WorkflowRun.id == uuid.UUID(run_id)).values(status="waiting_approval"))
        await session.commit()

    resp = await client.post(
        f"/api/v1/executions/{run_id}/resume",
        json={"decision": "approved", "comment": "Checked the invoice"},
        headers=ctx["headers"],
    )
    assert resp.status_code == 200, resp.text

    logs = await client.get("/api/v1/audit-logs", headers=ctx["headers"])
    actions = [row["action"] for row in logs.json()]
    assert AuditAction.WORKFLOW_RUN_STARTED in actions
    assert AuditAction.APPROVAL_APPROVED in actions

    approval = next(row for row in logs.json() if row["action"] == AuditAction.APPROVAL_APPROVED)
    assert approval["metadata"]["comment"] == "Checked the invoice"
    assert approval["resource_id"] == run_id


async def test_rejection_is_audited_distinctly_from_approval(client: AsyncClient):
    from test_executions import _register_and_publish, _trigger

    ctx = await _register_and_publish(client, "audit-reject")
    run_id = await _trigger(client, ctx["headers"], ctx["workflow_id"])

    async with async_session_maker() as session:
        from src.modules.executions.models import WorkflowRun

        await session.execute(update(WorkflowRun).where(WorkflowRun.id == uuid.UUID(run_id)).values(status="waiting_approval"))
        await session.commit()

    await client.post(
        f"/api/v1/executions/{run_id}/resume",
        json={"decision": "rejected", "comment": "Amount looks wrong"},
        headers=ctx["headers"],
    )

    logs = await client.get(f"/api/v1/audit-logs?action={AuditAction.APPROVAL_REJECTED}", headers=ctx["headers"])
    assert len(logs.json()) == 1
    assert logs.json()[0]["metadata"]["decision"] == "rejected"


async def test_byok_key_change_is_audited_without_the_key(client: AsyncClient):
    """
    A stored key is what the org's LLM spend bills against, so setting and
    removing one are material. The row must carry `last_four` and NOTHING more —
    the full key must not reach the audit trail any more than it reaches a
    response body.
    """
    from test_workflow_versions import register_and_get_token

    data = await register_and_get_token(client, "audit-byok")
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    secret_key = "sk-supersecretvalue9999"

    await client.put("/api/v1/integrations/openai_api_key", json={"api_key": secret_key}, headers=headers)
    await client.delete("/api/v1/integrations/openai_api_key", headers=headers)

    logs = await client.get("/api/v1/audit-logs", headers=headers)
    actions = [row["action"] for row in logs.json()]
    assert AuditAction.INTEGRATION_CREDENTIAL_SET in actions
    assert AuditAction.INTEGRATION_CREDENTIAL_DELETED in actions

    assert secret_key not in logs.text
    set_row = next(row for row in logs.json() if row["action"] == AuditAction.INTEGRATION_CREDENTIAL_SET)
    assert set_row["metadata"]["last_four"] == "9999"


async def test_webhook_secret_rotation_is_audited_without_the_secret(client: AsyncClient):
    from test_trigger_webhook import _webhook_workflow

    ctx = await _webhook_workflow(client, "audit-rotate")

    logs = await client.get(f"/api/v1/audit-logs?action={AuditAction.WEBHOOK_SECRET_ROTATED}", headers=ctx["headers"])
    assert len(logs.json()) == 1
    assert logs.json()[0]["metadata"]["replaced_existing"] is False
    assert ctx["secret"] not in logs.text


async def test_scheduled_run_is_audited_as_a_system_actor(client: AsyncClient):
    """No human triggered it, so actor_type is 'system' and actor_id is null."""
    from test_trigger_schedule import _dispatch_due_schedules_async, _force_due, _scheduled_published_workflow

    ctx = await _scheduled_published_workflow(client, "audit-sched")
    await _force_due(ctx["workflow_id"])
    await _dispatch_due_schedules_async()

    logs = await client.get(f"/api/v1/audit-logs?action={AuditAction.WORKFLOW_RUN_STARTED}", headers=ctx["headers"])
    rows = logs.json()
    assert len(rows) == 1
    assert rows[0]["actor_type"] == "system"
    assert rows[0]["actor_id"] is None
    assert rows[0]["metadata"]["trigger"] == "schedule"


async def test_audit_rows_are_org_scoped(client: AsyncClient):
    """Org A must never see Org B's audit trail — it names their people and IPs."""
    from test_executions import _register_and_publish

    ctx_a = await _register_and_publish(client, "audit-tenant-a")
    ctx_b = await _register_and_publish(client, "audit-tenant-b")

    logs_a = await client.get("/api/v1/audit-logs", headers=ctx_a["headers"])
    resource_ids = {row["resource_id"] for row in logs_a.json()}

    assert ctx_a["version_id"] in resource_ids
    assert ctx_b["version_id"] not in resource_ids


async def test_audit_write_rolls_back_with_its_action(client: AsyncClient):
    """
    The audit row shares the action's transaction. A publish that 409s (already
    published) must leave no audit row behind claiming it happened.
    """
    from test_executions import _register_and_publish

    ctx = await _register_and_publish(client, "audit-rollback")

    before = len(await _logs_for_org_from_token(client, ctx["headers"]))
    resp = await client.post(
        f"/api/v1/workflows/{ctx['workflow_id']}/versions/{ctx['version_id']}/publish",
        headers=ctx["headers"],
    )
    assert resp.status_code == 409
    after = len(await _logs_for_org_from_token(client, ctx["headers"]))
    assert after == before


async def _logs_for_org_from_token(client: AsyncClient, headers: dict) -> list:
    resp = await client.get("/api/v1/audit-logs", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# 4. Permission gating
# ---------------------------------------------------------------------------


def test_read_wildcard_does_not_grant_sensitive_read_permissions():
    """
    Regression test for a real hole found 2026-08-09. The Viewer system role
    holds "*:read", and permission_granted's wildcard branch used to satisfy
    EVERY `:read` from it — including integration:read and billing:read, both
    documented as Owner-only. audit:read would have inherited the same hole, and
    these rows carry actor identity and client IPs.
    """
    viewer = ["*:read"]
    assert permission_granted(viewer, "workflow:read") is True
    assert permission_granted(viewer, AUDIT_READ) is False
    assert permission_granted(viewer, INTEGRATION_READ) is False
    assert permission_granted(viewer, BILLING_READ) is False

    # Owner's "*" is unaffected — it still grants everything.
    assert permission_granted(["*"], AUDIT_READ) is True
    # And an explicit grant works.
    assert permission_granted([AUDIT_READ], AUDIT_READ) is True
