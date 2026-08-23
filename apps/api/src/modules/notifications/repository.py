"""
modules/notifications/repository.py — data access for notifications.

Two engines touch this table and that is deliberate, not an accident of
history: the async API path (a user reading their notifications) and a
SYNCHRONOUS path used by `notify` tool nodes and the delivery worker, which run
inside a LangGraph superstep / a Celery task with nothing to await. That is the
same split `ToolExecutionLogger` already makes, and `src/db/sync_database.py`
exists for exactly it.
"""

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy import update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.notifications.models import Notification


class NotificationRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def list_for_user(
        self,
        organization_id: uuid.UUID,
        user_id: uuid.UUID,
        *,
        unread_only: bool = False,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Sequence[Notification]:
        """
        A user's own notifications plus this org's broadcasts (`user_id IS NULL`).

        Scoped on `organization_id` AND the user in one predicate — a
        notification addressed to a colleague is not readable here even though
        they share a tenant, which is the one way this table differs from every
        other org-scoped list in the codebase.
        """
        stmt = select(Notification).where(
            Notification.organization_id == organization_id,
            (Notification.user_id == user_id) | (Notification.user_id.is_(None)),
        )
        if unread_only:
            stmt = stmt.where(Notification.read_at.is_(None))
        if cursor:
            stmt = stmt.where(Notification.created_at < datetime.fromisoformat(cursor))
        stmt = stmt.order_by(Notification.created_at.desc()).limit(limit)
        return (await self.db.execute(stmt)).scalars().all()

    async def get_for_user(self, organization_id: uuid.UUID, user_id: uuid.UUID, notification_id: uuid.UUID) -> Notification | None:
        stmt = select(Notification).where(
            Notification.id == notification_id,
            Notification.organization_id == organization_id,
            (Notification.user_id == user_id) | (Notification.user_id.is_(None)),
        )
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def set_read(self, notification_id: uuid.UUID, *, read: bool) -> None:
        await self.db.execute(sa_update(Notification).where(Notification.id == notification_id).values(read_at=datetime.now(UTC) if read else None))
