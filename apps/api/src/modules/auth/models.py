"""
modules/auth/models.py — Identity models: User, Role, OrgMembership.

Vol. 2 §3.1 — Identity & Tenancy
"""

import uuid

from sqlalchemy import Boolean, ForeignKey, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.db.base import Base, TimestampMixin, UUIDMixin


class User(UUIDMixin, TimestampMixin, Base):
    """
    Platform user account.

    email uses citext for case-insensitive uniqueness (enforced via the
    citext Postgres extension — enabled in the initial migration).
    hashed_password is nullable to support SSO-only accounts.
    """

    __tablename__ = "users"

    email: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        unique=True,
        comment="Case-insensitive unique — stored as citext in Postgres.",
    )
    hashed_password: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        comment="Argon2id hash.  Null for SSO-only accounts.",
    )
    full_name: Mapped[str] = mapped_column(Text, nullable=False)
    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_superadmin: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        comment="Platform-level admin flag; NOT an org admin.",
    )
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Relationships
    memberships: Mapped[list["OrgMembership"]] = relationship("OrgMembership", back_populates="user")


class Role(UUIDMixin, TimestampMixin, Base):
    """
    RBAC role definition.

    organization_id is nullable: null means a system-level role
    (Owner / Admin / Member / Viewer) shared across all organizations.
    Enterprise customers can define custom roles scoped to their org.

    permissions is a JSONB array of permission strings, e.g.:
        ["workflow:write", "billing:read", "member:invite"]
    """

    __tablename__ = "roles"

    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
        comment="Null = system-defined role available to all orgs.",
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    permissions: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        default=list,
        comment='Array of permission strings, e.g. ["workflow:write"].',
    )
    is_system: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        comment="True for the four built-in system roles.",
    )

    # Relationships
    memberships: Mapped[list["OrgMembership"]] = relationship("OrgMembership", back_populates="role")


class OrgMembership(UUIDMixin, TimestampMixin, Base):
    """
    Join table that records which user belongs to which organization
    and what role they hold within that organization.

    UNIQUE(organization_id, user_id) prevents duplicate membership rows.
    status drives the invite flow: invited → active, or → suspended.
    """

    __tablename__ = "org_memberships"
    __table_args__ = (UniqueConstraint("organization_id", "user_id", name="uq_org_membership"),)

    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    role_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("roles.id", ondelete="RESTRICT"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="invited",
        comment="invited | active | suspended",
    )

    # Relationships
    user: Mapped["User"] = relationship("User", back_populates="memberships")
    role: Mapped["Role"] = relationship("Role", back_populates="memberships")
    organization: Mapped["Organization"] = relationship(  # type: ignore[name-defined]
        "Organization", back_populates="memberships"
    )
