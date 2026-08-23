"""
modules/notifications/service.py — queueing and delivering notifications.

Two entry points with different execution models, both real:

- `queue_notification_sync` — called by a `notify` tool node inside a LangGraph
  superstep. Synchronous, via `src/db/sync_database.py`, because there is
  nothing to await in there. Writes the row, commits, enqueues delivery.
- `deliver_notification_sync` — called by `worker_notifications`. Performs the
  transport and records the outcome.

`NotificationService` is the ordinary async half, for the read API.

**Why delivery is asynchronous.** Vol. 5 puts Notify at the END of every HR
workflow, after the leave is approved and after the payroll run is released.
Delivering inline would let a Slack outage fail a run whose real work already
succeeded and was already signed off by a human — the single worst place to put
a third party in the critical path. The row is the record of intent; the worker
owns the transport.
"""

import logging
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import HTTPException, status
from sqlalchemy import update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.notifications.models import Notification
from src.modules.notifications.repository import NotificationRepository
from src.modules.notifications.schemas import NotificationResponse

logger = logging.getLogger(__name__)

#: Delivery attempt budget inside ONE worker task. The Celery task adds its own
#: retry on top; this is the fast in-process retry for a blip.
_MAX_DELIVERY_ATTEMPTS = 3
_DELIVERY_TIMEOUT_SECONDS = 10.0
#: `notifications.error` is read back by an operator, not parsed. A remote server
#: returning an HTML error page must not put a kilobyte of markup in a column.
_MAX_ERROR_LENGTH = 500


def _sync_maker() -> Any:
    from src.db.sync_database import get_sync_session_maker

    return get_sync_session_maker()


def queue_notification_sync(
    *,
    organization_id: str,
    user_id: str | None,
    channel: str,
    url: str | None,
    payload: dict[str, Any],
) -> uuid.UUID:
    """
    Write the row and hand delivery to `worker_notifications`.

    `in_app` is marked delivered on the spot and enqueues nothing: the row IS
    the delivery for that channel, and queueing a task whose only job is to set
    a column would be a round-trip through Redis to accomplish an UPDATE.

    The enqueue happens AFTER the commit, deliberately. The reverse order races:
    `worker_notifications` is a separate process and can pick the task up before
    this transaction commits, then fail to find the row it was told to deliver.
    """
    delivered = channel == "in_app"
    now = datetime.now(UTC)
    notification = Notification(
        organization_id=uuid.UUID(organization_id),
        user_id=uuid.UUID(user_id) if user_id else None,
        channel=channel,
        payload={**payload, **({"url": url} if url else {})},
        status="delivered" if delivered else "pending",
        delivered_at=now if delivered else None,
    )
    with _sync_maker()() as session:
        session.add(notification)
        session.commit()
        notification_id = notification.id

    if not delivered:
        from src.workers.notification_tasks import deliver_notification

        deliver_notification.delay(str(notification_id))

    return notification_id


def deliver_notification_sync(notification_id: str) -> str:
    """
    Perform the transport for one queued notification. Returns the final status.

    Idempotent on `delivered`: Celery's `task_acks_late` means a worker crash
    after delivery but before the ack causes a redelivery, and a Slack channel
    with the same message twice is a real (if small) harm. A row already marked
    delivered is a no-op.
    """
    maker = _sync_maker()
    with maker() as session:
        row = session.get(Notification, uuid.UUID(notification_id))
        if row is None:
            logger.warning("deliver_notification: notification %s no longer exists", notification_id)
            return "missing"
        if row.status == "delivered":
            return "delivered"
        channel, payload = row.channel, dict(row.payload)

    url = payload.pop("url", None)
    if channel != "webhook" or not url:
        outcome, error = "failed", f"Channel {channel!r} has no transport implemented."
    else:
        outcome, error = _post_webhook(url, payload)

    with maker() as session:
        session.execute(
            sa_update(Notification)
            .where(Notification.id == uuid.UUID(notification_id))
            .values(
                status=outcome,
                delivered_at=datetime.now(UTC) if outcome == "delivered" else None,
                error=error[:_MAX_ERROR_LENGTH] if error else None,
            )
        )
        session.commit()
    return outcome


def _safe(url: str) -> str:
    """Strip the query string. An incoming-webhook URL is a bearer credential."""
    base, sep, _ = url.partition("?")
    return f"{base}?<redacted>" if sep else base


def _post_webhook(url: str, payload: dict[str, Any]) -> tuple[str, str | None]:
    """
    POST to an incoming webhook (Slack, Teams, Zapier — all the same shape).

    `text` is included alongside the structured payload because Slack renders
    that key and ignores unknown ones; a receiver that wants the structure still
    has it. This is the one channel-specific accommodation, and it is additive
    rather than a per-vendor code path.

    Unlike `http_request`'s tool node this retries a 5xx freely: re-POSTing a
    notification is at worst a duplicate message, never a duplicate journal
    entry. The reverse of the idempotency rule, and for the same reason —
    what matters is the cost of a replay.
    """
    lines = [payload.get("title", ""), payload.get("body", "")]
    lines += [f"{k}: {v}" for k, v in (payload.get("fields") or {}).items()]
    body = {**payload, "text": "\n".join(part for part in lines if part)}

    last_error: str | None = None
    with httpx.Client(timeout=_DELIVERY_TIMEOUT_SECONDS, follow_redirects=True, max_redirects=3) as client:
        for attempt in range(_MAX_DELIVERY_ATTEMPTS):
            try:
                response = client.post(url, json=body)
            except httpx.HTTPError as exc:
                last_error = f"{type(exc).__name__}: {exc}"
            else:
                if response.status_code < 400:
                    return "delivered", None
                last_error = f"HTTP {response.status_code} from {_safe(url)}"
                if response.status_code < 500 and response.status_code != 429:
                    break  # a definitive rejection; retrying cannot help
            logger.warning(
                "Notification delivery attempt %d/%d to %s failed: %s",
                attempt + 1,
                _MAX_DELIVERY_ATTEMPTS,
                _safe(url),
                last_error,
            )
    return "failed", last_error


class NotificationService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repository = NotificationRepository(db)

    async def list_for_user(
        self,
        organization_id: uuid.UUID,
        user_id: uuid.UUID,
        *,
        unread_only: bool = False,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Sequence[NotificationResponse]:
        rows = await self.repository.list_for_user(organization_id, user_id, unread_only=unread_only, cursor=cursor, limit=limit)
        return [NotificationResponse.model_validate(row) for row in rows]

    async def set_read(self, organization_id: uuid.UUID, user_id: uuid.UUID, notification_id: uuid.UUID, *, read: bool) -> NotificationResponse:
        row = await self.repository.get_for_user(organization_id, user_id, notification_id)
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found.")
        await self.repository.set_read(notification_id, read=read)
        await self.db.refresh(row)
        return NotificationResponse.model_validate(row)
