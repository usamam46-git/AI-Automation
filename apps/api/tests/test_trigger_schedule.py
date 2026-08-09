"""
tests/test_trigger_schedule.py — cron-driven workflow triggers (Vol. 2 §5).

Two layers:
  1. Pure unit tests over validate_trigger_config / compute_next_run_at — cron
     grammar, timezone handling, the sub-minute floor.
  2. Integration tests over dispatch_due_schedules against the real test DB —
     which workflows the tick picks up, which it must NOT, and the re-arm
     behaviour (including the deliberate no-catch-up rule).

The guard conditions in (2) are the ones worth pinning hardest: every run this
tick creates can spend money on LLM calls with nobody watching, so "a draft
never fires" and "one tick fires a workflow at most once" are cost-safety
properties, not tidiness.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update

from src.db.database import async_session_maker
from src.modules.executions.models import WorkflowRun
from src.modules.workflows.models import Workflow
from src.modules.workflows.service import (
    GraphValidationError,
    compute_next_run_at,
    validate_trigger_config,
)
from src.workers.trigger_tasks import _advance_from, _dispatch_due_schedules_async

# No `pytestmark = pytest.mark.asyncio` — pyproject sets asyncio_mode = "auto",
# which collects async tests automatically. An explicit module-level mark also
# lands on the sync unit tests below and warns on every one of them.


# ---------------------------------------------------------------------------
# 1. Pure unit tests — cron parsing and next-fire computation
# ---------------------------------------------------------------------------


def test_valid_weekday_cron_accepted():
    validate_trigger_config("schedule", {"cron": "0 9 * * 1-5"})


@pytest.mark.parametrize(
    "config, fragment",
    [
        ({}, "requires trigger_config.cron"),
        ({"cron": ""}, "requires trigger_config.cron"),
        ({"cron": "not a cron"}, "Invalid cron expression"),
        ({"cron": "0 9 * * 1-5", "timezone": "Mars/Olympus"}, "Unknown timezone"),
        ({"cron": "0 9 * * 1-5", "timezone": 5}, "must be a string"),
    ],
)
def test_malformed_schedule_config_rejected(config, fragment):
    with pytest.raises(GraphValidationError) as exc:
        validate_trigger_config("schedule", config)
    assert fragment in str(exc.value.detail)


def test_sub_minute_cron_rejected():
    """
    croniter.is_valid() accepts a 6-field expression with a seconds column, so
    the floor has to be measured from the actual gap between fire times rather
    than pattern-matched on the string. A 30-second schedule cannot be honoured
    by a 60-second tick, and silently running it every 60s would be a lie.
    """
    with pytest.raises(GraphValidationError) as exc:
        validate_trigger_config("schedule", {"cron": "*/30 * * * * *"})
    assert "more often than once per minute" in str(exc.value.detail)


def test_every_minute_cron_is_allowed_at_the_boundary():
    """Exactly 60s is the floor, not below it — '* * * * *' must still pass."""
    validate_trigger_config("schedule", {"cron": "* * * * *"})


@pytest.mark.parametrize("trigger_type", ["email", "event"])
def test_unimplemented_trigger_types_rejected(trigger_type):
    with pytest.raises(GraphValidationError) as exc:
        validate_trigger_config(trigger_type, None)
    assert "not implemented yet" in str(exc.value.detail)


@pytest.mark.parametrize("trigger_type", ["manual", "webhook"])
def test_non_schedule_types_need_no_cron(trigger_type):
    validate_trigger_config(trigger_type, None)
    assert compute_next_run_at(trigger_type, {"cron": "0 9 * * *"}) is None


def test_cron_is_evaluated_in_the_configured_timezone():
    """
    '0 9 * * *' means 9am LOCAL. Evaluated in Asia/Karachi (UTC+5) that is
    04:00 UTC. Evaluating it in UTC instead would silently shift every run by
    the offset — and drift by an hour twice a year in DST zones.
    """
    after = datetime(2026, 8, 9, 0, 0, tzinfo=UTC)

    karachi = compute_next_run_at("schedule", {"cron": "0 9 * * *", "timezone": "Asia/Karachi"}, after=after)
    utc = compute_next_run_at("schedule", {"cron": "0 9 * * *", "timezone": "UTC"}, after=after)

    assert karachi == datetime(2026, 8, 9, 4, 0, tzinfo=UTC)
    assert utc == datetime(2026, 8, 9, 9, 0, tzinfo=UTC)


def test_computed_next_run_is_always_aware_utc():
    result = compute_next_run_at("schedule", {"cron": "*/5 * * * *", "timezone": "America/New_York"})
    assert result is not None
    assert result.tzinfo is not None
    assert result.utcoffset() == timedelta(0)


def test_advance_from_suppresses_catch_up():
    """
    The re-arm base is `now`, never the stale due time. A workflow six hours
    overdue fires ONCE and resumes its cadence — it does not replay six runs.
    """
    now = datetime(2026, 8, 9, 15, 0, tzinfo=UTC)
    six_hours_stale = datetime(2026, 8, 9, 9, 0, tzinfo=UTC)

    assert _advance_from(now, six_hours_stale) == now

    next_fire = compute_next_run_at("schedule", {"cron": "0 * * * *"}, after=_advance_from(now, six_hours_stale))
    assert next_fire == datetime(2026, 8, 9, 16, 0, tzinfo=UTC)


# ---------------------------------------------------------------------------
# 2. Integration — the beat tick against the real DB
# ---------------------------------------------------------------------------


async def _scheduled_published_workflow(client: AsyncClient, tag: str, *, cron: str = "0 * * * *") -> dict:
    """Publish a runnable graph, then switch it to a schedule trigger."""
    from test_executions import _register_and_publish

    ctx = await _register_and_publish(client, f"sched-{tag}")
    resp = await client.patch(
        f"/api/v1/workflows/{ctx['workflow_id']}",
        json={"trigger_type": "schedule", "trigger_config": {"cron": cron}},
        headers=ctx["headers"],
    )
    assert resp.status_code == 200, resp.text
    return ctx


async def _force_due(workflow_id: str, *, due_at: datetime | None = None) -> None:
    """Backdate next_run_at so the tick considers the workflow due now."""
    async with async_session_maker() as session:
        await session.execute(
            update(Workflow).where(Workflow.id == uuid.UUID(workflow_id)).values(next_run_at=due_at or datetime.now(UTC) - timedelta(seconds=30))
        )
        await session.commit()


async def _reload(workflow_id: str) -> Workflow:
    async with async_session_maker() as session:
        result = await session.execute(select(Workflow).where(Workflow.id == uuid.UUID(workflow_id)))
        return result.scalar_one()


async def _runs_for(workflow_version_id: str) -> list[WorkflowRun]:
    async with async_session_maker() as session:
        result = await session.execute(select(WorkflowRun).where(WorkflowRun.workflow_version_id == uuid.UUID(workflow_version_id)))
        return list(result.scalars().all())


async def test_due_published_workflow_is_dispatched_and_rearmed(client: AsyncClient):
    ctx = await _scheduled_published_workflow(client, "due")
    await _force_due(ctx["workflow_id"])

    created = await _dispatch_due_schedules_async()

    assert len(created) == 1
    runs = await _runs_for(ctx["version_id"])
    assert len(runs) == 1
    assert runs[0].status == "pending"
    assert runs[0].trigger_payload["_trigger"] == "schedule"

    workflow = await _reload(ctx["workflow_id"])
    assert workflow.last_triggered_at is not None
    # Re-armed into the future, so the next tick will not re-fire it.
    assert workflow.next_run_at is not None
    assert workflow.next_run_at > datetime.now(UTC)


async def test_second_tick_does_not_refire_the_same_workflow(client: AsyncClient):
    """The re-arm is what makes the tick idempotent. This is the double-spend guard."""
    ctx = await _scheduled_published_workflow(client, "once")
    await _force_due(ctx["workflow_id"])

    first = await _dispatch_due_schedules_async()
    second = await _dispatch_due_schedules_async()

    assert len(first) == 1
    assert second == []
    assert len(await _runs_for(ctx["version_id"])) == 1


async def test_draft_workflow_with_a_due_cron_never_fires(client: AsyncClient):
    """
    A schedule can be configured before the workflow is published — the create
    path arms next_run_at regardless. The tick's status='published' AND
    current_version_id guard is the only thing stopping an unfinished graph from
    running on a timer.
    """
    from test_workflow_versions import create_workspace, register_and_get_token

    data = await register_and_get_token(client, "sched-draft")
    token = data["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    ws = await create_workspace(client, token)

    resp = await client.post(
        "/api/v1/workflows",
        json={
            "name": "Never Runs",
            "workspace_id": ws["id"],
            "trigger_type": "schedule",
            "trigger_config": {"cron": "* * * * *"},
        },
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    workflow_id = resp.json()["id"]
    # Armed at creation...
    assert resp.json()["next_run_at"] is not None

    await _force_due(workflow_id)
    assert await _dispatch_due_schedules_async() == []

    # ...and still armed, untouched — the tick did not even claim the row.
    workflow = await _reload(workflow_id)
    assert workflow.last_triggered_at is None


async def test_manual_workflow_is_never_dispatched(client: AsyncClient):
    """A published manual workflow with a stray due next_run_at must be ignored."""
    from test_executions import _register_and_publish

    ctx = await _register_and_publish(client, "sched-manual")
    await _force_due(ctx["workflow_id"])

    assert await _dispatch_due_schedules_async() == []
    assert await _runs_for(ctx["version_id"]) == []


async def test_not_yet_due_workflow_is_left_alone(client: AsyncClient):
    ctx = await _scheduled_published_workflow(client, "future")
    await _force_due(ctx["workflow_id"], due_at=datetime.now(UTC) + timedelta(hours=1))

    assert await _dispatch_due_schedules_async() == []


async def test_switching_away_from_schedule_clears_next_run_at(client: AsyncClient):
    """
    Otherwise a stale next_run_at keeps a no-longer-scheduled workflow firing.
    The tick also filters on trigger_type, so this is belt-and-braces — but the
    column would be misleading to anyone reading the row.
    """
    ctx = await _scheduled_published_workflow(client, "switch")
    assert (await _reload(ctx["workflow_id"])).next_run_at is not None

    resp = await client.patch(
        f"/api/v1/workflows/{ctx['workflow_id']}",
        json={"trigger_type": "manual"},
        headers=ctx["headers"],
    )
    assert resp.status_code == 200, resp.text
    assert (await _reload(ctx["workflow_id"])).next_run_at is None


async def test_patching_only_the_cron_revalidates_against_the_stored_type(client: AsyncClient):
    """
    Trigger fields are independently PATCHable. Sending a bad cron alone, with
    trigger_type already 'schedule' on the row, must still 422 — validation
    reads the MERGED pair, not just the submitted keys.
    """
    ctx = await _scheduled_published_workflow(client, "merge")

    resp = await client.patch(
        f"/api/v1/workflows/{ctx['workflow_id']}",
        json={"trigger_config": {"cron": "nonsense"}},
        headers=ctx["headers"],
    )
    assert resp.status_code == 422, resp.text
    assert "Invalid cron expression" in resp.text


async def test_creating_a_workflow_with_an_unimplemented_trigger_is_rejected(client: AsyncClient):
    """
    The UI must not be able to create a workflow that can never fire. Before
    2026-08-09 this returned 201 and the workflow sat inert forever.
    """
    from test_workflow_versions import create_workspace, register_and_get_token

    data = await register_and_get_token(client, "sched-email")
    token = data["access_token"]
    ws = await create_workspace(client, token)

    resp = await client.post(
        "/api/v1/workflows",
        json={"name": "Email Trigger", "workspace_id": ws["id"], "trigger_type": "email"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 422, resp.text
    assert "not implemented yet" in resp.text


async def test_tick_dispatches_across_orgs_but_scopes_each_run_to_its_owner(client: AsyncClient):
    """
    The tick is deliberately global — it is not running as any tenant. What must
    hold is that each created run carries the organization_id of ITS OWN
    workflow, read off the row rather than shared.
    """
    ctx_a = await _scheduled_published_workflow(client, "org-a")
    ctx_b = await _scheduled_published_workflow(client, "org-b")
    await _force_due(ctx_a["workflow_id"])
    await _force_due(ctx_b["workflow_id"])

    created = await _dispatch_due_schedules_async()
    assert len(created) == 2

    run_a = (await _runs_for(ctx_a["version_id"]))[0]
    run_b = (await _runs_for(ctx_b["version_id"]))[0]
    wf_a = await _reload(ctx_a["workflow_id"])
    wf_b = await _reload(ctx_b["workflow_id"])

    assert run_a.organization_id == wf_a.organization_id
    assert run_b.organization_id == wf_b.organization_id
    assert run_a.organization_id != run_b.organization_id
