"""
modules/billing/models.py — Stub billing models (§3.6, fields TBD).

Full field definitions will be added when we reach the dedicated billing
section. These stubs satisfy the FK reference and ensure Alembic generates
the tables with the correct structure upfront.

Tables:
  billing_accounts      — one billing account per organization
  billing_usage_records — append-only usage event ledger
"""

from sqlalchemy import Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from src.db.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class BillingAccount(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """
    Stub: one billing account per organization.
    Full fields (Stripe customer ID, plan limits, payment method, etc.)
    will be added in a dedicated billing migration.
    """

    __tablename__ = "billing_accounts"

    name: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="",
        comment="Stub field — will be replaced with proper billing fields.",
    )
    config: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="Catch-all for billing config until the billing section is fleshed out.",
    )


class BillingUsageRecord(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """
    Stub: append-only usage event (token spend, run counts, etc.).
    Full fields will be added in the billing section.
    """

    __tablename__ = "billing_usage_records"

    name: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="",
        comment="Stub: event type identifier (e.g. 'llm_token_spend').",
    )
    payload: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="Catch-all for usage event details.",
    )
