"""
workers/celery_app.py — Celery application configuration.

Queue topology (Vol. 2 §5.1):
  workflow_execution — LLM-latency-bound graph runs (concurrency=4, prefetch=1)
  dead_letter        — tasks that exhausted all retries

Only the workflow_execution queue is implemented this phase.
document_processing and notifications queues are deferred until their
respective modules exist.
"""

from celery import Celery

from src.core.config import settings

celery_app = Celery(
    "aap_workers",
    broker=settings.CELERY_BROKER_URL,
    # Result backend disabled per Decision 10 — run state lives in
    # workflow_runs / node_executions, not Celery's result store.
    backend=None,
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
    },
)
