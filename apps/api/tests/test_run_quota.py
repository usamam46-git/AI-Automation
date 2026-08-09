"""
tests/test_run_quota.py — per-organization daily workflow-run quota (Vol. 2 §667).

§667: "Per organization, workflow triggers | Plan-dependent (e.g. 1,000 runs/day
on Pro) | Redis counter, resets daily; enforced before Celery enqueue."

The properties worth pinning are mostly about WHERE the check sits:
  - before the enqueue, and before the run row exists, so an over-quota request
    never leaves a `pending` run nothing will execute;
  - on all three trigger paths (manual, webhook, schedule), because a cron is
    the easiest way to exhaust an allowance unattended;
  - NOT on resume, or an approval-heavy workflow would cost double;
  - AFTER webhook signature verification, or an anonymous attacker could burn a
    tenant's whole day of runs with forged requests.
"""

import uuid
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update

from src.core.cache import RunQuotaExceeded, consume_run_quota, get_run_quota_usage
from src.core.redis import get_redis_client
from src.db.database import async_session_maker
from src.modules.executions.models import WorkflowRun


@pytest.fixture
async def redis():
    return await get_redis_client()


async def _runs_for(version_id: str) -> list[WorkflowRun]:
    async with async_session_maker() as session:
        result = await session.execute(select(WorkflowRun).where(WorkflowRun.workflow_version_id == uuid.UUID(version_id)))
        return list(result.scalars().all())


async def _org_id_from_token(token: str) -> str:
    from src.core.security import decode_access_token

    return decode_access_token(token)["org_id"]


async def _exhaust(redis, org_id: str, limit: int) -> None:
    """Burn the org's whole allowance so the next claim is the one over the line."""
    for _ in range(limit):
        await consume_run_quota(redis, org_id, limit=limit)


# ---------------------------------------------------------------------------
# The counter itself
# ---------------------------------------------------------------------------


async def test_consume_increments_and_reports_usage(redis):
    org = str(uuid.uuid4())
    assert await get_run_quota_usage(redis, org) == 0

    assert await consume_run_quota(redis, org, limit=5) == 1
    assert await consume_run_quota(redis, org, limit=5) == 2
    assert await get_run_quota_usage(redis, org) == 2


async def test_exceeding_the_limit_raises(redis):
    org = str(uuid.uuid4())
    await _exhaust(redis, org, 3)

    with pytest.raises(RunQuotaExceeded) as exc:
        await consume_run_quota(redis, org, limit=3)
    assert exc.value.limit == 3
    assert exc.value.retry_after_seconds > 0


async def test_quota_is_per_organization(redis):
    """One tenant exhausting its allowance must not affect another."""
    org_a, org_b = str(uuid.uuid4()), str(uuid.uuid4())
    await _exhaust(redis, org_a, 2)

    with pytest.raises(RunQuotaExceeded):
        await consume_run_quota(redis, org_a, limit=2)
    assert await consume_run_quota(redis, org_b, limit=2) == 1


async def test_zero_limit_disables_enforcement(redis):
    org = str(uuid.uuid4())
    for _ in range(50):
        assert await consume_run_quota(redis, org, limit=0) == 0


async def test_counter_expires_at_utc_midnight(redis):
    """
    §667 says the quota "resets daily", not that it rolls. The UTC date is part
    of the key and the TTL runs to the next midnight, so the full allowance
    comes back at once rather than trickling in hour by hour.
    """
    from src.core.cache import CacheKey, _seconds_until_utc_midnight

    org = str(uuid.uuid4())
    await consume_run_quota(redis, org, limit=10)

    today = datetime.now(UTC).strftime("%Y-%m-%d")
    key = CacheKey.rate_limit("org_runs", f"{org}:{today}")
    ttl = await redis.ttl(key)

    assert 0 < ttl <= _seconds_until_utc_midnight(datetime.now(UTC)) + 1


# ---------------------------------------------------------------------------
# Enforcement on the trigger paths
# ---------------------------------------------------------------------------


async def test_manual_trigger_429s_when_over_quota(client: AsyncClient, redis, monkeypatch):
    from test_executions import _register_and_publish

    from src.core.config import settings

    monkeypatch.setattr(settings, "DAILY_RUN_QUOTA_PER_ORG", 2)
    ctx = await _register_and_publish(client, "quota-manual")

    for _ in range(2):
        ok = await client.post(f"/api/v1/workflows/{ctx['workflow_id']}/run", json={"trigger_payload": {}}, headers=ctx["headers"])
        assert ok.status_code == 201, ok.text

    blocked = await client.post(f"/api/v1/workflows/{ctx['workflow_id']}/run", json={"trigger_payload": {}}, headers=ctx["headers"])
    assert blocked.status_code == 429, blocked.text
    assert "Retry-After" in blocked.headers
    assert "quota" in blocked.json()["detail"].lower()


async def test_over_quota_request_creates_no_run_row(client: AsyncClient, redis, monkeypatch):
    """
    The check sits before create_run, so a rejected trigger leaves nothing
    behind. A `pending` run that nothing will ever execute looks exactly like
    the three worker bugs fixed on 2026-08-07 and would be diagnosed as one.
    """
    from test_executions import _register_and_publish

    from src.core.config import settings

    monkeypatch.setattr(settings, "DAILY_RUN_QUOTA_PER_ORG", 1)
    ctx = await _register_and_publish(client, "quota-norow")

    await client.post(f"/api/v1/workflows/{ctx['workflow_id']}/run", json={"trigger_payload": {}}, headers=ctx["headers"])
    blocked = await client.post(f"/api/v1/workflows/{ctx['workflow_id']}/run", json={"trigger_payload": {}}, headers=ctx["headers"])

    assert blocked.status_code == 429
    assert len(await _runs_for(ctx["version_id"])) == 1


async def test_over_quota_request_enqueues_nothing(client: AsyncClient, redis, monkeypatch, celery_calls):
    from test_executions import _register_and_publish

    from src.core.config import settings

    monkeypatch.setattr(settings, "DAILY_RUN_QUOTA_PER_ORG", 1)
    ctx = await _register_and_publish(client, "quota-noenqueue")

    await client.post(f"/api/v1/workflows/{ctx['workflow_id']}/run", json={"trigger_payload": {}}, headers=ctx["headers"])
    celery_calls.clear()

    blocked = await client.post(f"/api/v1/workflows/{ctx['workflow_id']}/run", json={"trigger_payload": {}}, headers=ctx["headers"])
    assert blocked.status_code == 429
    assert celery_calls == []


async def test_webhook_trigger_is_quota_limited(client: AsyncClient, redis, monkeypatch):
    from test_trigger_webhook import _sign, _webhook_workflow

    from src.core.config import settings

    monkeypatch.setattr(settings, "DAILY_RUN_QUOTA_PER_ORG", 1)
    ctx = await _webhook_workflow(client, "quota-hook")

    body = b"{}"
    first = await client.post(ctx["endpoint"], content=body, headers=_sign(ctx["secret"], body))
    second = await client.post(ctx["endpoint"], content=body, headers=_sign(ctx["secret"], body))

    assert first.status_code == 202
    assert second.status_code == 429


async def test_forged_webhook_requests_cannot_burn_the_quota(client: AsyncClient, redis, monkeypatch):
    """
    The ordering that matters most on the unauthenticated route: quota is
    claimed only AFTER the signature verifies. Claiming first would let anyone
    who knows a workflow UUID exhaust that tenant's entire daily allowance with
    garbage requests — a remote, credential-free denial of service.
    """
    from test_trigger_webhook import _sign, _webhook_workflow

    from src.core.config import settings

    monkeypatch.setattr(settings, "DAILY_RUN_QUOTA_PER_ORG", 2)
    ctx = await _webhook_workflow(client, "quota-forged")
    org_id = await _org_id_from_token(ctx["token"])

    body = b"{}"
    for _ in range(10):
        forged = await client.post(ctx["endpoint"], content=body, headers=_sign("whsec_wrong", body))
        assert forged.status_code == 401

    assert await get_run_quota_usage(redis, org_id) == 0

    # The real caller still has its full allowance.
    ok = await client.post(ctx["endpoint"], content=body, headers=_sign(ctx["secret"], body))
    assert ok.status_code == 202


async def test_resume_does_not_consume_quota(client: AsyncClient, redis, monkeypatch):
    """
    Approving a waiting run continues a run already counted at trigger time.
    Charging again would make an approval-heavy workflow silently cost double
    its quota, and Vol. 5's reference workflows all have approval gates.
    """
    from test_executions import _register_and_publish, _trigger

    from src.core.config import settings

    monkeypatch.setattr(settings, "DAILY_RUN_QUOTA_PER_ORG", 1)
    ctx = await _register_and_publish(client, "quota-resume")
    org_id = await _org_id_from_token(ctx["token"])

    run_id = await _trigger(client, ctx["headers"], ctx["workflow_id"])
    assert await get_run_quota_usage(redis, org_id) == 1

    async with async_session_maker() as session:
        await session.execute(update(WorkflowRun).where(WorkflowRun.id == uuid.UUID(run_id)).values(status="waiting_approval"))
        await session.commit()

    resumed = await client.post(f"/api/v1/executions/{run_id}/resume", json={"decision": "approved"}, headers=ctx["headers"])
    assert resumed.status_code == 200, resumed.text
    assert await get_run_quota_usage(redis, org_id) == 1


async def test_schedule_tick_skips_over_quota_orgs_but_still_rearms(client: AsyncClient, redis, monkeypatch):
    """
    A throttled scheduled workflow must NOT accumulate a backlog — next_run_at
    still advances, so it rejoins its cadence at the next occurrence instead of
    stampeding the moment the quota resets at midnight.
    """
    from test_trigger_schedule import _dispatch_due_schedules_async, _force_due, _reload, _scheduled_published_workflow

    from src.core.config import settings

    monkeypatch.setattr(settings, "DAILY_RUN_QUOTA_PER_ORG", 1)
    ctx = await _scheduled_published_workflow(client, "quota-sched")
    org_id = await _org_id_from_token(ctx["token"])

    await consume_run_quota(redis, org_id, limit=1)  # exhaust it

    await _force_due(ctx["workflow_id"])
    created = await _dispatch_due_schedules_async()

    assert created == []
    assert await _runs_for(ctx["version_id"]) == []

    workflow = await _reload(ctx["workflow_id"])
    assert workflow.next_run_at is not None
    assert workflow.next_run_at > datetime.now(UTC)


async def test_quota_exceeded_on_a_schedule_is_audited(client: AsyncClient, redis, monkeypatch):
    """A silently skipped scheduled run would be indistinguishable from a bug."""
    from test_trigger_schedule import _dispatch_due_schedules_async, _force_due, _scheduled_published_workflow

    from src.core.config import settings
    from src.modules.audit_logs.service import AuditAction

    monkeypatch.setattr(settings, "DAILY_RUN_QUOTA_PER_ORG", 1)
    ctx = await _scheduled_published_workflow(client, "quota-audit")
    org_id = await _org_id_from_token(ctx["token"])
    await consume_run_quota(redis, org_id, limit=1)

    await _force_due(ctx["workflow_id"])
    await _dispatch_due_schedules_async()

    logs = await client.get(f"/api/v1/audit-logs?action={AuditAction.RUN_QUOTA_EXCEEDED}", headers=ctx["headers"])
    assert logs.status_code == 200, logs.text
    rows = logs.json()
    assert len(rows) == 1
    assert rows[0]["metadata"]["trigger"] == "schedule"
    assert rows[0]["metadata"]["limit"] == 1
