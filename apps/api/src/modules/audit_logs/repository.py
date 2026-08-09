"""
modules/audit_logs/repository.py — Queries for the append-only audit trail.

INSERT and SELECT only. There is no update() and no delete() here, and adding
one would fail at runtime anyway — the database rejects both (migration
20260809_audit_log_immutability).
"""

import uuid
from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.audit_logs.models import AuditLog


class AuditLogRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def create(
        self,
        *,
        organization_id: uuid.UUID,
        actor_type: str,
        actor_id: uuid.UUID | None,
        action: str,
        resource_type: str,
        resource_id: uuid.UUID | None,
        event_metadata: dict | None,
        ip_address: str | None,
    ) -> AuditLog:
        """
        Add a row to the session. Deliberately does NOT commit.

        The audit row must land in the same transaction as the action it
        records, so that either both persist or neither does. A commit here
        would break that: the action could still roll back afterwards, leaving
        an audit trail claiming something happened that did not.
        """
        row = AuditLog(
            organization_id=organization_id,
            actor_type=actor_type,
            actor_id=actor_id,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            event_metadata=event_metadata,
            ip_address=ip_address,
        )
        self.db.add(row)
        await self.db.flush()
        return row

    async def list_by_org(
        self,
        organization_id: uuid.UUID,
        *,
        action: str | None = None,
        resource_type: str | None = None,
        resource_id: uuid.UUID | None = None,
        actor_id: uuid.UUID | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Sequence[AuditLog]:
        """
        Newest first, cursor-paginated on raw ISO `created_at` — the same
        convention as the Workflows and Executions lists.
        """
        stmt = select(AuditLog).where(AuditLog.organization_id == organization_id).order_by(desc(AuditLog.created_at)).limit(limit)

        if action is not None:
            stmt = stmt.where(AuditLog.action == action)
        if resource_type is not None:
            stmt = stmt.where(AuditLog.resource_type == resource_type)
        if resource_id is not None:
            stmt = stmt.where(AuditLog.resource_id == resource_id)
        if actor_id is not None:
            stmt = stmt.where(AuditLog.actor_id == actor_id)

        if cursor:
            # Same shape as WorkflowRepository.list_by_org: a malformed cursor is
            # ignored rather than 400'd, so a stale bookmark degrades to page one.
            try:
                cursor_dt = datetime.fromisoformat(cursor)
                stmt = stmt.where(AuditLog.created_at < cursor_dt)
            except ValueError:
                pass

        result = await self.db.execute(stmt)
        return result.scalars().all()
