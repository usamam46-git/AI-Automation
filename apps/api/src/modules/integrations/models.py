"""
modules/integrations/models.py — Stub external integration model (§3.6).

Integrations represent connections to third-party services (Gmail, NetSuite,
QuickBooks, Slack, etc.).  Full fields (OAuth token storage, connector type,
sync status) will be added when we reach the integrations section.

credentials in the full implementation will be AES-256-GCM encrypted at the
application layer before being stored (see Vol. 2 §13).
"""

from sqlalchemy import Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from src.db.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Integration(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """
    Stub: external service integration owned by an Organization.
    Full fields (service type, OAuth tokens, sync config, etc.)
    will be added in the integrations section.
    """

    __tablename__ = "integrations"

    name: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="Stub: human-readable integration name, e.g. 'NetSuite Production'.",
    )
    config: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="Catch-all for integration config until the section is fleshed out.",
    )
