"""
workers/celery_app.py — Celery application configuration.

Queue topology (Vol. 2 §5.1):
  workflow_execution  — LLM-latency-bound graph runs (concurrency=4, prefetch=1)
  document_processing — knowledge-base ingestion (concurrency=8, prefetch=2)
  notifications       — outbound notification delivery (concurrency=4)
  dead_letter         — tasks that exhausted all retries

document_processing went live 2026-08-15 with knowledge-base ingestion, and
notifications on 2026-08-23 with the `notify` tool type. **All three worker
containers now have a non-empty task registry**; the beat tick stays routed to
workflow_execution, which is now a choice (a short DB query does not warrant its
own container) rather than the necessity it was when the other two queues had no
consumers.

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
    include=[
        "src.workers.graph_tasks",
        "src.workers.trigger_tasks",
        # Added 2026-08-15 with the ingestion pipeline. worker_documents has
        # consumed `-Q document_processing` since the initial commit with an
        # empty registry; this is the first task routed there.
        "src.workers.document_tasks",
        # Added 2026-08-23 with the `notify` tool type. Same milestone for
        # worker_notifications, which had likewise booted with nothing
        # registered since the initial commit — which is why every Vol. 5 HR
        # workflow's terminal Notify step had nothing to compile to.
        "src.workers.notification_tasks",
    ],
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
        # Live as of 2026-08-15 (knowledge-base ingestion). The queue name must
        # match worker_documents' `-Q document_processing` in docker-compose.
        "document_processing": {
            "exchange": "document_processing",
            "routing_key": "document_processing",
        },
        # Live as of 2026-08-23 (the `notify` tool type). The queue name must
        # match worker_notifications' `-Q notifications` in docker-compose.
        "notifications": {
            "exchange": "notifications",
            "routing_key": "notifications",
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
        # Ingestion is I/O-bound (object storage + embedding round-trips), not
        # LLM-latency-bound like a graph run, which is why it gets its own
        # container at concurrency 8 rather than sharing workflow_execution.
        "src.workers.document_tasks.ingest_document": {"queue": "document_processing"},
        # Its own container because delivery blocks on a third party for up to
        # 10s per attempt, and a Slack outage must not occupy a slot that graph
        # runs need. This is also why delivery is off the run's critical path at
        # all — see modules/notifications/service.py.
        "src.workers.notification_tasks.deliver_notification": {"queue": "notifications"},
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
