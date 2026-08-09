"""
workers/celery_app.py — Celery application configuration.

Queue topology (Vol. 2 §5.1):
  workflow_execution — LLM-latency-bound graph runs (concurrency=4, prefetch=1)
  dead_letter        — tasks that exhausted all retries

Only the workflow_execution queue is implemented this phase.
document_processing and notifications queues are deferred until their
respective modules exist — the containers for both boot with empty task
registries, which is why the beat tick is routed to workflow_execution.

Beat: one periodic entry, `dispatch-due-schedules` (added 2026-08-09), which
drives cron-triggered workflows. See workers/trigger_tasks.py.
"""

from celery import Celery

import src.db.all_models  # noqa: F401 — registers every ORM mapper; see module docstring
from src.core.config import settings

celery_app = Celery(
    "aap_workers",
    broker=settings.CELERY_BROKER_URL,
    # Result backend disabled per Decision 10 — run state lives in
    # workflow_runs / node_executions, not Celery's result store.
    backend=None,
    # Required: `celery -A src.workers.celery_app worker` imports THIS module
    # only. Without an explicit include the task registry is empty, the worker
    # boots clean, and then discards every job with "Received unregistered task
    # of type ...". The test suite cannot catch that — it bypasses the broker
    # and awaits _stream_graph() directly — so this is only ever visible when a
    # run triggered from the UI sits at `pending` forever.
    include=["src.workers.graph_tasks", "src.workers.trigger_tasks"],
)

celery_app.conf.update(
    # Serialization
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    # Timezone
    timezone="UTC",
    enable_utc=True,
    # Reliability — ack only after the task function returns so a worker
    # crash causes the broker to redeliver the task.
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    # Vol. 2 §5.1 tuning: 1 task pre-fetched per worker process so that
    # long-running LLM tasks don't starve newly queued jobs.
    worker_prefetch_multiplier=1,
    # Queue definitions
    task_queues={
        "workflow_execution": {
            "exchange": "workflow_execution",
            "routing_key": "workflow_execution",
        },
        "dead_letter": {
            "exchange": "dead_letter",
            "routing_key": "dead_letter",
        },
    },
    task_default_queue="workflow_execution",
    task_default_exchange="workflow_execution",
    task_default_routing_key="workflow_execution",
    # Route dead-lettered tasks explicitly
    task_routes={
        "src.workers.graph_tasks.execute_workflow": {"queue": "workflow_execution"},
        "src.workers.graph_tasks.resume_workflow": {"queue": "workflow_execution"},
        # Routed to workflow_execution because worker_workflow is the only
        # container with a non-empty task registry — worker_documents and
        # worker_notifications still boot with nothing registered. The tick is
        # a short DB query, so it does not meaningfully occupy an LLM slot.
        "src.workers.trigger_tasks.dispatch_due_schedules": {"queue": "workflow_execution"},
    },
    # ---------------------------------------------------------------------
    # Beat schedule (Vol. 2 §5 — "Celery Beat / scheduled triggers")
    #
    # Exactly one entry, deliberately. The per-workflow cron lives in
    # `workflows.next_run_at`, and this tick polls for what is due; beat never
    # learns about individual workflows. See workers/trigger_tasks.py for why
    # that beats registering a beat entry per workflow.
    #
    # One minute is also the floor enforced on user-supplied crons
    # (MIN_SCHEDULE_INTERVAL_SECONDS) — a finer cron could not be honoured.
    # ---------------------------------------------------------------------
    beat_schedule={
        "dispatch-due-schedules": {
            "task": "src.workers.trigger_tasks.dispatch_due_schedules",
            "schedule": 60.0,
            "options": {"queue": "workflow_execution", "expires": 55},
        },
    },
)
