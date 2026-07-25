"""
modules/audit_logs/models.py — Append-only audit trail.

Vol. 2 §3.5 — Chat, Notifications, Audit
Vol. 2 §13 — Security

audit_logs is APPEND-ONLY.  There must be no UPDATE or DELETE routes for this
table at the application layer, and a Postgres trigger (created in the initial
migration) rejects any UPDATE/DELETE attempt at the database layer as well.

actor_type and actor_id identify who performed the action:
  - user   : a human user (actor_id = users.id)
  - agent  : an automated agent node (actor_id = agent_sessions.id)
  - system : platform-level system action (actor_id = null)

The composite index (organization_id, created_at DESC) and monthly
partitioning are handled in the hand-written index migration.
"""

import uuid

from sqlalchemy import Text
from sqlalchemy.dialects.postgresql import INET, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from src.db.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class AuditLog(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """
    Immutable audit event.  Every material action in the platform produces
    at least one AuditLog row.

    action examples:
      workflow.published  workflow.run.started  workflow.run.completed
      approval.approved   approval.rejected     document.uploaded
      member.invited      member.removed        api_key.created

    resource_type / resource_id point to the entity the action was performed on.
    metadata is a free-form JSONB dict with action-specific context (diff,
    before/after values, approval comments, etc.).
    ip_address is stored for security audits and is optional (system actions
    have no IP).
    """

    __tablename__ = "audit_logs"

    actor_type: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="user | agent | system",
    )
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        nullable=True,
        comment="FK to users.id or agent_sessions.id depending on actor_type.",
    )
    action: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="Dot-separated action identifier, e.g. 'workflow.published'.",
    )
    resource_type: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="Table / entity type the action was performed on.",
    )
    resource_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        nullable=True,
        comment="PK of the affected entity.",
    )
    event_metadata: Mapped[dict | None] = mapped_column(
        "metadata",
        JSONB,
        nullable=True,
        comment="Action-specific context (before/after values, comments, etc.).",
    )
    ip_address: Mapped[str | None] = mapped_column(
        INET,
        nullable=True,
        comment="Client IP at the time of the action (null for system actions).",
    )
