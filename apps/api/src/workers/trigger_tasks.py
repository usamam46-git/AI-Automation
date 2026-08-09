"""
workers/trigger_tasks.py — Scheduled (cron) workflow triggers.

Vol. 2 §5's architecture diagram has "Celery Beat / scheduled triggers" feeding
the queues. Until 2026-08-09 nothing implemented it: `workflows.trigger_type`
accepted `'schedule'` and the Builder offered it, but no code ever read the
column, and the `beat` container booted with an empty schedule.

Design — one tick, DB poll
--------------------------
A single beat entry (`dispatch-due-schedules`, in celery_app.py) fires once a
minute and enqueues this task. The task queries for schedule-triggered
workflows whose `next_run_at` has come due, creates a WorkflowRun for each, and
re-arms `next_run_at` from the cron.

The alternative — registering one beat entry per scheduled workflow — was
rejected: beat's schedule is process-local, so every create/update/delete would
need a live reconfiguration channel into a running container, and a beat restart
would silently drop every workflow-specific entry until something rebuilt them.
A DB poll has none of that: the database is the schedule, so a restarted beat
is instantly correct and a workflow edited through the API takes effect on the
next tick with no signalling at all.

Where this runs
---------------
Beat only *publishes* the tick; a worker executes it. That matters because the
`beat` container in infra/docker-compose.yml has no DATABASE_URL — it never
touches Postgres and doesn't need to. The task is routed to `workflow_execution`
because `worker_workflow` is the only container with a non-empty task registry
(`worker_documents` and `worker_notifications` still boot with nothing
registered).

Cost safety
-----------
Every run this enqueues can spend money on LLM calls with no human in the loop,
which makes the guard conditions load-bearing rather than defensive:

- Only `status='published'` workflows with a non-null `current_version_id` are
  ever picked up. A draft carrying a cron accumulates a due `next_run_at` that
  simply never matches.
- `next_run_at` is advanced in the SAME transaction that creates the run, and
  the selecting statement takes `FOR UPDATE SKIP LOCKED`, so two overlapping
  ticks (or two worker processes) cannot both fire the same workflow.
- Catch-up is deliberately suppressed: a workflow whose `next_run_at` is six
  hours stale fires ONCE and is then re-armed relative to *now*, not replayed
  six times. See _advance_from().
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from celery import Task
from sqlalchemy import select

from src.core.cache import RunQuotaExceeded, consume_run_quota
from src.core.redis import get_redis_client
from src.db.database import async_session_maker
from src.modules.audit_logs.schemas import AuditContext
from src.modules.audit_logs.service import AuditAction, AuditService
from src.modules.executions.repository import ExecutionRepository
from src.modules.workflows.models import Workflow
from src.modules.workflows.service import compute_next_run_at
from src.workers.celery_app import celery_app
from src.workers.graph_tasks import _run_async

logger = logging.getLogger(__name__)

#: Ceiling on how many workflows one tick will dispatch. A backlog larger than
#: this drains over subsequent ticks rather than tying up a worker slot (and a
#: burst of LLM spend) in a single task.
MAX_DISPATCH_PER_TICK = 100


def _advance_from(now: datetime, due_at: datetime | None) -> datetime:
    """
    The base time to compute the next occurrence from.

    Always `now`, never the stale `due_at` — that is what suppresses catch-up.
    If the worker was down from 09:00 to 15:00, an hourly workflow should run
    once on recovery and then resume hourly, not fire six backdated runs whose
    payloads are all identical and whose LLM cost is six times the intent.

    `due_at` is accepted (and logged on drift) purely so this decision is
    visible at the call site rather than implicit in a missing argument.
    """
    if due_at is not None and (now - due_at).total_seconds() > 3600:
        logger.warning(
            "Schedule drift: due_at=%s is more than an hour behind now=%s. "
            "Firing once and re-arming from now (catch-up is intentionally suppressed).",
            due_at,
            now,
        )
    return now


async def _dispatch_due_schedules_async() -> list[uuid.UUID]:
    """
    Returns the run ids created, so the Celery task can enqueue them AFTER the
    transaction commits. Enqueueing inside the transaction would race: the
    worker can pick the job up and query for a WorkflowRun row that is not
    visible yet.
    """
    now = datetime.now(UTC)
    created: list[uuid.UUID] = []

    async with async_session_maker() as session:
        stmt = (
            select(Workflow)
            .where(
                Workflow.trigger_type == "schedule",
                Workflow.status == "published",
                Workflow.current_version_id.is_not(None),
                Workflow.next_run_at.is_not(None),
                Workflow.next_run_at <= now,
            )
            .order_by(Workflow.next_run_at)
            .limit(MAX_DISPATCH_PER_TICK)
            # Two ticks can overlap if one runs long. SKIP LOCKED lets the second
            # pass over rows the first already claimed instead of blocking on
            # them or, worse, double-firing them.
            .with_for_update(skip_locked=True)
        )
        workflows = (await session.execute(stmt)).scalars().all()

        if not workflows:
            return []

        exec_repo = ExecutionRepository(session)
        audit = AuditService(session)
        redis = await get_redis_client()

        for workflow in workflows:
            assert workflow.current_version_id is not None  # guaranteed by the WHERE clause

            # Scheduled runs count against the org's daily allowance exactly
            # like manual and webhook ones — a cron is the *easiest* way to
            # exhaust a quota, since nobody is watching it. Over-quota
            # workflows are skipped, NOT retried: `next_run_at` still advances
            # below, so a throttled workflow rejoins its normal cadence at the
            # next occurrence instead of accumulating a backlog that stampedes
            # the moment the quota resets at midnight.
            try:
                await consume_run_quota(redis, str(workflow.organization_id))
            except RunQuotaExceeded as exc:
                logger.warning(
                    "Skipping scheduled run for workflow=%s — org=%s is over its daily quota (%d/%d).",
                    workflow.id,
                    workflow.organization_id,
                    exc.used,
                    exc.limit,
                )
                await audit.record(
                    organization_id=workflow.organization_id,
                    context=AuditContext.system(),
                    action=AuditAction.RUN_QUOTA_EXCEEDED,
                    resource_type="workflow",
                    resource_id=workflow.id,
                    metadata={"trigger": "schedule", "limit": exc.limit, "used": exc.used},
                )
                workflow.last_triggered_at = now
                workflow.next_run_at = compute_next_run_at(
                    workflow.trigger_type,
                    workflow.trigger_config,
                    after=_advance_from(now, workflow.next_run_at),
                )
                continue

            run = await exec_repo.create_run(
                organization_id=workflow.organization_id,
                workflow_version_id=workflow.current_version_id,
                trigger_payload={
                    "_trigger": "schedule",
                    "_scheduled_for": workflow.next_run_at.isoformat() if workflow.next_run_at else None,
                    "_fired_at": now.isoformat(),
                },
            )
            await audit.record(
                organization_id=workflow.organization_id,
                context=AuditContext.system(),
                action=AuditAction.WORKFLOW_RUN_STARTED,
                resource_type="workflow_run",
                resource_id=run.id,
                metadata={"workflow_id": str(workflow.id), "trigger": "schedule"},
            )

            workflow.last_triggered_at = now
            workflow.next_run_at = compute_next_run_at(
                workflow.trigger_type,
                workflow.trigger_config,
                after=_advance_from(now, workflow.next_run_at),
            )
            created.append(run.id)

        # One commit for every run created plus every re-arm. If this fails,
        # nothing fired and nothing advanced — the next tick retries the same set.
        await session.commit()

    return created


@celery_app.task(
    bind=True,
    name="src.workers.trigger_tasks.dispatch_due_schedules",
    queue="workflow_execution",
    # No retries. The next tick is 60s away and re-selects the same rows, which
    # is a cleaner recovery than a retry storm — and a retry that fired runs the
    # first attempt already committed would double-execute them.
    max_retries=0,
    soft_time_limit=110,
    time_limit=120,
)
def dispatch_due_schedules(self: Task) -> int:
    """
    Beat tick. Enqueues one execute_workflow job per due scheduled workflow.
    Returns the count dispatched (visible in worker logs; there is no result
    backend — Decision 10).
    """
    from src.workers.graph_tasks import execute_workflow

    try:
        run_ids = _run_async(_dispatch_due_schedules_async())
    except Exception:
        # Swallow rather than propagate: an unhandled exception here marks the
        # periodic task failed and logs a traceback every 60s until fixed, which
        # buries every other worker log. The next tick retries identically.
        logger.exception("dispatch_due_schedules failed; the next tick will retry the same rows.")
        return 0

    for run_id in run_ids:
        execute_workflow.delay(str(run_id))

    if run_ids:
        logger.info("Schedule tick dispatched %d run(s): %s", len(run_ids), [str(r) for r in run_ids])
    return len(run_ids)
