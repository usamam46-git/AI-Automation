import datetime

"""
modules/notifications/models.py — In-app, email, and channel notifications.

Vol. 2 §3.5 — Chat, Notifications, Audit

Notifications can be org-wide (user_id=null) or targeted at a specific user.
channel determines the delivery mechanism. Only `in_app` and `webhook` are
implemented (2026-08-23); the rest are vocabulary with no transport behind them.
payload is a JSONB bag containing the notification body, deep-link URL,
related resource references, and any channel-specific formatting hints.
"""

import uuid

from sqlalchemy import ForeignKey, Text
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import Mapped, mapped_column

from src.db.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Notification(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """
    A single notification delivered to a user or broadcast to an organization.

    user_id is nullable — null means the notification is org-wide (e.g., a
    system-level alert to all org admins).

    channel: in_app | email | whatsapp | slack
    read_at: null until the user opens/dismisses the notification.
    """

    __tablename__ = "notifications"

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
        comment="Null = org-wide notification.",
    )
    channel: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="in_app | webhook (implemented) | email | whatsapp | slack (vocabulary only, nothing delivers these).",
    )
    payload: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        comment="Notification body, deep-link, resource refs, channel formatting hints.",
    )
    read_at: Mapped[datetime.datetime | None] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=True,
        comment="Set when the user marks the notification as read.",
    )
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="pending",
        server_default="pending",
        comment="pending | delivered | failed. Delivery state, distinct from read_at (which is the RECIPIENT's action).",
    )
    delivered_at: Mapped[datetime.datetime | None] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=True,
        comment="When the channel accepted it. Equals created_at for in_app, which needs no transport.",
    )
    error: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        comment="Last delivery failure. Query-stripped — a webhook URL routinely carries its token there.",
    )
