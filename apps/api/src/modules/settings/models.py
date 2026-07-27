"""
modules/settings/models.py — Stub organizational settings model (§3.6).

Stores key-value style configuration at the organization level (e.g., default
timezone, notification preferences, branding overrides beyond what fits in
organizations.settings).  Full fields TBD.
"""

from sqlalchemy import Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from src.db.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Setting(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """
    Stub: org-level setting entry.
    key will be the setting identifier; payload the structured value.
    Full field list TBD.
    """

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="Setting identifier, e.g. 'default_timezone'.",
    )
    payload: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="Setting value as a structured JSONB object.",
    )
