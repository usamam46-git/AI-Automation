"""
db/base.py — Shared SQLAlchemy declarative base and column mixins.

All ORM models in the application inherit from these mixins to guarantee
a consistent primary-key / timestamp / tenant-id contract across every table.
"""

import uuid

from sqlalchemy import Boolean, ForeignKey, text
from sqlalchemy.dialects.postgresql import TIMESTAMPTZ, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.sql import func


# ---------------------------------------------------------------------------
# Declarative base
# Every ORM model in the project inherits from this class.
# ---------------------------------------------------------------------------

class Base(DeclarativeBase):
    """Project-wide SQLAlchemy declarative base."""
    pass


# ---------------------------------------------------------------------------
# Mixins
# ---------------------------------------------------------------------------

class UUIDMixin:
    """
    Provides a UUID primary key with a server-side default of gen_random_uuid().

    Using server_default keeps the PK generation inside Postgres, which means
    the INSERT does not need a Python-side uuid4() call and the value is
    always available after a flush (SQLAlchemy fetches it on INSERT).
    """

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )


class TimestampMixin:
    """
    Provides `created_at` and `updated_at` TIMESTAMPTZ columns.

    - created_at: set once by Postgres on INSERT, never changed.
    - updated_at: set by Postgres on INSERT and refreshed on every UPDATE
      via onupdate=func.now() (SQLAlchemy-level hook; complement with a
      Postgres trigger for updates that bypass the ORM, e.g. bulk SQL).
    """

    created_at: Mapped[str] = mapped_column(
        TIMESTAMPTZ,
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[str] = mapped_column(
        TIMESTAMPTZ,
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class TenantMixin:
    """
    Provides `organization_id` — a non-nullable FK to organizations.id.

    Every tenant-scoped table carries this column.  The repository base class
    automatically injects `WHERE organization_id = :org_id` into every query,
    and the RLS policies in Postgres enforce the same constraint as a second
    line of defence (see migration xxxx_enable_rls_policies.py).

    The column is indexed (index=True) to support the common query pattern
    `SELECT ... WHERE organization_id = ? AND ...` efficiently.
    """

    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
