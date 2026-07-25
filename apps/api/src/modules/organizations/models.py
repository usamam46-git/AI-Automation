import datetime

"""
modules/organizations/models.py — Organization (tenant root) and APIKey.

Vol. 2 §3.1 — Identity & Tenancy

NOTE: Organization does NOT use TenantMixin — it IS the tenant root.
      Its id is the organization_id that all other tables reference.
"""

import uuid

from sqlalchemy import Boolean, ForeignKey, Text
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.db.base import Base, TimestampMixin, UUIDMixin


class Organization(UUIDMixin, TimestampMixin, Base):
    """
    Top-level tenant entity.

    Every piece of customer data is scoped to an Organization via
    organization_id FK.  The Organization row itself has no such FK —
    it is the root of the ownership tree.

    plan drives billing limits and feature flags checked by the API.
    settings is a catch-all JSONB bag for org-level feature flags, branding
    overrides, and future org preferences.
    """

    __tablename__ = "organizations"

    name: Mapped[str] = mapped_column(Text, nullable=False)
    slug: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        unique=True,
        comment="URL-safe lowercase identifier, e.g. 'acme-corp'.",
    )
    plan: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="free",
        comment="free | pro | enterprise — drives billing limits.",
    )
    settings: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="Org-level feature flags, branding config, etc.",
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
        comment="Soft-disable an org without deleting its data.",
    )

    # Relationships
    workspaces: Mapped[list["Workspace"]] = relationship(  # type: ignore[name-defined]
        "Workspace", back_populates="organization"
    )
    api_keys: Mapped[list["APIKey"]] = relationship(
        "APIKey", back_populates="organization"
    )
    memberships: Mapped[list["OrgMembership"]] = relationship(  # type: ignore[name-defined]
        "OrgMembership", back_populates="organization"
    )


class APIKey(UUIDMixin, TimestampMixin, Base):
    """
    Per-organization API key for programmatic/service-to-service access.

    The raw key is shown to the user ONCE at creation time and never stored.
    hashed_key stores a SHA-256 hash used for O(1) key lookup on every
    authenticated request (unique index defined in the index migration).

    key_prefix stores the first 8 characters of the raw key so users can
    identify which key is which in the UI without exposing the full value.
    """

    __tablename__ = "api_keys"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    key_prefix: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="First 8 chars of the raw key — displayed in the UI.",
    )
    hashed_key: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="SHA-256 hash of the raw key.  Unique index added in index migration.",
    )
    scopes: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="Array of permission scope strings.",
    )
    last_used_at: Mapped[datetime.datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    expires_at: Mapped[datetime.datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    revoked_at: Mapped[datetime.datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    # Relationships
    organization: Mapped["Organization"] = relationship(
        "Organization", back_populates="api_keys"
    )
