"""
modules/audit_logs/service.py — Writing and reading the append-only audit trail.

Vol. 2 §13 §700: "audit_logs rows are insert-only at the application layer (no
UPDATE/DELETE route exists), and a Postgres trigger rejects UPDATE/DELETE at the
database layer as well." Both halves landed 2026-08-09; before that the table
existed and nothing had ever written to it.

Why not the event bus
---------------------
`src/core/events.py` already publishes WorkflowVersionPublishedEvent and
friends, and subscribing an audit handler to it looks tempting. It was rejected,
and re-attempting it would silently break the trail:

- `EventBus.publish` dispatches with `asyncio.create_task(...)` and never awaits
  or stores the task. A handler that raises loses its exception into a
  never-retrieved task result, so a failing audit write is invisible.
- The request's DB session is closed when the request ends, which can happen
  before the detached task runs.
- Nothing orders the write relative to the action's commit, so an event fired
  before a rollback would record something that never happened.

An audit trail whose writes are best-effort is not an audit trail. `record()`
therefore runs inline, on the caller's session, inside the caller's
transaction — either both the action and its audit row commit, or neither does.
"""

import uuid
from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.audit_logs.models import AuditLog
from src.modules.audit_logs.repository import AuditLogRepository
from src.modules.audit_logs.schemas import AuditContext


class AuditAction:
    """
    The action vocabulary. String constants rather than an Enum because the
    column is free-text `action` and Vol. 2 §3.5 documents it as an open,
    dot-separated namespace — a closed Enum would force a migration-shaped
    change every time a new material action is added.

    Only actions that something actually writes are listed. Do not pre-declare
    aspirational ones; an empty constant reads like coverage that does not exist.
    """

    WORKFLOW_PUBLISHED = "workflow.published"
    WORKFLOW_ARCHIVED = "workflow.archived"
    WORKFLOW_RUN_STARTED = "workflow.run.started"
    APPROVAL_APPROVED = "approval.approved"
    APPROVAL_REJECTED = "approval.rejected"
    INTEGRATION_CREDENTIAL_SET = "integration.credential.set"
    INTEGRATION_CREDENTIAL_DELETED = "integration.credential.deleted"
    WEBHOOK_SECRET_ROTATED = "webhook_secret.rotated"
    RUN_QUOTA_EXCEEDED = "workflow.run.quota_exceeded"


class AuditService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self._repo = AuditLogRepository(db)

    async def record(
        self,
        *,
        organization_id: uuid.UUID,
        context: AuditContext,
        action: str,
        resource_type: str,
        resource_id: uuid.UUID | None = None,
        metadata: dict | None = None,
    ) -> AuditLog:
        """
        Append one audit row to the caller's open transaction.

        Never commits — see the module docstring. The caller's existing commit
        persists the audit row alongside the action.

        `metadata` must never carry a secret. Callers record identifiers,
        before/after values and decisions; the two current credential actions
        deliberately record only the integration type and `last_four`.
        """
        return await self._repo.create(
            organization_id=organization_id,
            actor_type=context.actor_type.value,
            actor_id=context.actor_id,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            event_metadata=metadata,
            ip_address=context.ip_address,
        )

    async def list_logs(
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
        return await self._repo.list_by_org(
            organization_id,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            actor_id=actor_id,
            cursor=cursor,
            limit=limit,
        )
