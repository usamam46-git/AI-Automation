"""
modules/webhooks/models.py — Stub webhook registration model (§3.6).

Webhooks allow external systems to push events into AAP, or AAP to push
events out to external URLs.  Full fields (event filter, signing secret,
delivery log, retry config) will be added when we reach this section.
"""


from sqlalchemy import Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from src.db.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Webhook(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """
    Stub: webhook registration owned by an Organization.
    Full fields (URL, signing secret, event types, delivery log) will
    be added in the webhooks section.
    """

    __tablename__ = "webhooks"

    name: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="Stub: human-readable webhook name.",
    )
    config: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="Catch-all for webhook config (URL, secret, event filter) until fleshed out.",
    )
