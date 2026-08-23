"""
workers/notification_tasks.py — the `notifications` queue's first task.

`worker_notifications` has consumed `-Q notifications` since the initial commit
with an **empty task registry**: it booted clean, registered nothing, and would
have discarded any job with "Received unregistered task of type ...". This is the
first thing routed there, the same milestone `document_tasks.ingest_document`
was for `worker_documents` on 2026-08-15.

Two invariants from workers/CLAUDE.md apply here and are easy to miss:

- **`celery_app.include` must name this module.** The worker imports only
  `celery_app`, so a task defined in an un-included module is invisible.
- **Workers do NOT bind-mount `src/`; only `api` does.** This file is not in the
  `worker_notifications` image until it is rebuilt, and the symptom is the task
  simply missing from the `[tasks]` list at boot with no error anywhere.
  `docker compose build worker_notifications` after any change under
  `src/workers/`.

No `_run_async` here, unlike every other task module: delivery is synchronous
end to end (psycopg2 + a blocking httpx POST), so there is no event loop to
manage and none of the pooled-connection-across-loops hazard that wrapper exists
to solve.
"""

import logging

from src.workers.celery_app import celery_app

logger = logging.getLogger(__name__)


@celery_app.task(
    name="src.workers.notification_tasks.deliver_notification",
    bind=True,
    max_retries=3,
    # 1min, 2min, 4min. Far longer than the in-process attempts in
    # `_post_webhook`, because a task-level retry is for an outage rather than a
    # blip — a Slack incident lasts minutes, not milliseconds.
    default_retry_delay=60,
    retry_backoff=True,
)
def deliver_notification(self, notification_id: str) -> str:
    """
    Deliver one queued notification.

    **A permanently failed notification must not be retried forever, and must not
    be silent either.** The row carries `status='failed'` and the last error, so
    the outcome is queryable rather than living only in a log line — which is the
    whole reason `status`/`error` were added to the table (migration
    `20260823_notify`).

    Retries only on a transport failure the service itself could not resolve.
    `deliver_notification_sync` already distinguishes a definitive 4xx (which it
    does not retry in-process) from a 5xx/429, so a `failed` return here is
    either a hard rejection or an exhausted outage — neither improves by being
    re-driven immediately.
    """
    from src.modules.notifications.service import deliver_notification_sync

    outcome = deliver_notification_sync(notification_id)

    if outcome == "failed" and self.request.retries < self.max_retries:
        logger.warning(
            "Notification %s failed to deliver (attempt %d/%d) — retrying",
            notification_id,
            self.request.retries + 1,
            self.max_retries,
        )
        raise self.retry()

    logger.info("Notification %s delivery finished: %s", notification_id, outcome)
    return outcome
