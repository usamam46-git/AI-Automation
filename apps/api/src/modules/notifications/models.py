"""
modules/notifications/models.py — In-app, email, and channel notifications.

Vol. 2 §3.5 — Chat, Notifications, Audit

Notifications can be org-wide (user_id=null) or targeted at a specific user.
channel determines the delivery mechanism.
payload is a JSONB bag containing the notification body, deep-link URL,
related resource references, and any channel-specific formatting hints.
"""

import uuid
from typing import Optional

from sqlalchemy import ForeignKey, Text
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMPTZ, UUID
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

    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
        comment="Null = org-wide notification.",
    )
    channel: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="in_app | email | whatsapp | slack",
    )
    payload: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        comment="Notification body, deep-link, resource refs, channel formatting hints.",
    )
    read_at: Mapped[Optional[str]] = mapped_column(
        TIMESTAMPTZ,
        nullable=True,
        comment="Set when the user marks the notification as read.",
    )
