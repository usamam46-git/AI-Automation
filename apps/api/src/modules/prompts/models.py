import datetime
"""
modules/prompts/models.py — Prompt registry and versioning.

Vol. 2 §3.3 — Agents, Tools, Prompts

Tables:
  prompts         — named prompt entity owned by a Workspace
  prompt_versions — immutable versioned Jinja2 templates with variable schemas

Design notes:
- Prompts are decoupled from Agents so the same prompt can be reused by
  multiple agents and A/B tested independently.
- variables_schema is a JSON Schema dict validated against runtime variables
  before rendering, catching missing-variable bugs at render time rather than
  producing a malformed prompt silently.
- template uses Jinja2-style {{variable}} syntax.
"""

import uuid
from typing import Optional

from sqlalchemy import ForeignKey, Integer, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.db.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Prompt(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """Named prompt entity owned by a Workspace."""

    __tablename__ = "prompts"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Relationships
    workspace: Mapped["Workspace"] = relationship(  # type: ignore[name-defined]
        "Workspace", back_populates="prompts"
    )
    versions: Mapped[list["PromptVersion"]] = relationship(
        "PromptVersion", back_populates="prompt"
    )


class PromptVersion(UUIDMixin, TimestampMixin, Base):
    """
    Immutable versioned snapshot of a Prompt's Jinja2 template and variable schema.

    UNIQUE(prompt_id, version_number) prevents duplicate version numbers.
    """

    __tablename__ = "prompt_versions"
    __table_args__ = (
        UniqueConstraint("prompt_id", "version_number", name="uq_prompt_version"),
    )

    prompt_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("prompts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    template: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="Jinja2-style template with {{variable}} placeholders.",
    )
    variables_schema: Mapped[Optional[dict]] = mapped_column(
        JSONB,
        nullable=True,
        comment="JSON Schema for expected template variables — validated before rendering.",
    )

    # Relationships
    prompt: Mapped["Prompt"] = relationship("Prompt", back_populates="versions")
