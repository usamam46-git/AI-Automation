"""
modules/integrations/models.py — External integration credentials (§3.6, Vol. 2 §13).

Real for one type today: `openai_api_key` (BYOK). Other integration types
(Slack, NetSuite/QuickBooks OAuth, etc.) will reuse this same shape — the
`type` discriminator plus `config` catch-all exist so adding a second type
later is a new row, not a schema rewrite.
"""

from sqlalchemy import LargeBinary, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from src.db.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Integration(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """External service credential owned by an Organization."""

    __tablename__ = "integrations"
    __table_args__ = (UniqueConstraint("organization_id", "type", name="uq_integrations_org_type"),)

    name: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="Human-readable name, e.g. 'OpenAI API Key'.",
    )
    type: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="Integration type discriminator, e.g. 'openai_api_key'.",
    )
    credentials: Mapped[bytes | None] = mapped_column(
        LargeBinary,
        nullable=True,
        comment="AES-256-GCM encrypted secret (nonce || ciphertext+tag) — see src/core/encryption.py. Never the raw value (Vol. 2 §13).",
    )
    last_four: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        comment="Last 4 characters of the raw secret, stored in plaintext, for masked display only.",
    )
    config: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="Catch-all for non-secret settings. Unused by openai_api_key today.",
    )
