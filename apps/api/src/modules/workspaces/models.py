"""
modules/workspaces/models.py — Workspace model (owns its own module per
Volume 1 §12 repo structure).

Vol. 2 §3.1 — Identity & Tenancy

A Workspace is a logical grouping WITHIN an Organization (e.g., "Finance",
"HR").  All workflow, agent, prompt, tool, knowledge-base, and chat entities
belong to a Workspace, not directly to an Organization.
"""


from sqlalchemy import Boolean, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.db.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Workspace(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """
    Logical namespace within an organization.

    Uses TenantMixin (organization_id FK + index) because workspaces are
    owned by and scoped to an organization.

    is_default: every organization has exactly one default workspace created
    on signup.  Enforced at the application layer.
    """

    __tablename__ = "workspaces"

    name: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="Human-readable name, e.g. 'Finance', 'HR Operations'.",
    )
    icon: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        comment="Emoji or icon identifier displayed in the UI.",
    )
    is_default: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        comment="True for the organization's auto-created default workspace.",
    )

    # Relationships (back-references populated by child modules)
    organization: Mapped["Organization"] = relationship(  # type: ignore[name-defined]
        "Organization", back_populates="workspaces"
    )
    workflows: Mapped[list["Workflow"]] = relationship(  # type: ignore[name-defined]
        "Workflow", back_populates="workspace"
    )
    agents: Mapped[list["Agent"]] = relationship(  # type: ignore[name-defined]
        "Agent", back_populates="workspace"
    )
    prompts: Mapped[list["Prompt"]] = relationship(  # type: ignore[name-defined]
        "Prompt", back_populates="workspace"
    )
    tools: Mapped[list["Tool"]] = relationship(  # type: ignore[name-defined]
        "Tool", back_populates="workspace"
    )
    knowledge_bases: Mapped[list["KnowledgeBase"]] = relationship(  # type: ignore[name-defined]
        "KnowledgeBase", back_populates="workspace"
    )
    chats: Mapped[list["Chat"]] = relationship(  # type: ignore[name-defined]
        "Chat", back_populates="workspace"
    )
