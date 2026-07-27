"""
modules/tools/models.py — Tool registry and execution logs.

Vol. 2 §3.3 — Agents, Tools, Prompts

Tables:
  tools            — tool definition owned by a Workspace
  tool_executions  — append-only log of every tool invocation

Design notes:
- tool_type drives which executor class is used at runtime (polymorphic by
  type string, not by SQLAlchemy polymorphism — keeping the ORM simple).
- input_schema (JSON Schema) is what gets sent to OpenAI as a function-
  calling / tool spec — the tool registry IS the function-calling contract.
- config stores type-specific config (endpoint URL, auth reference, etc.)
  encrypted at the application layer for secrets (see Vol. 2 §13).
"""

import uuid
from typing import Optional

from sqlalchemy import ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.db.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Tool(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """
    A callable tool definition available to agents within a Workspace.

    tool_type:
      - http_request       : generic authenticated HTTP call
      - python_function    : sandboxed, pre-registered Python callable
      - erp_connector      : purpose-built ERP adapter (Vol. 5)
      - mcp                : Model Context Protocol client (future-compat slot)
    """

    __tablename__ = "tools"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    tool_type: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="http_request | python_function | erp_connector | mcp",
    )
    input_schema: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="JSON Schema exposed to the LLM as its function-calling spec.",
    )
    config: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="Type-specific config (endpoint URL, auth refs, etc.).",
    )

    # Relationships
    workspace: Mapped["Workspace"] = relationship(  # type: ignore[name-defined]
        "Workspace", back_populates="tools"
    )
    executions: Mapped[list["ToolExecution"]] = relationship("ToolExecution", back_populates="tool")


class ToolExecution(UUIDMixin, TimestampMixin, Base):
    """
    Append-only log of a single tool invocation.

    node_execution_id links back to the specific node execution that triggered
    this tool call — nullable because tools can also be invoked outside of a
    workflow run (e.g., during testing in the tool playground).
    """

    __tablename__ = "tool_executions"

    tool_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tools.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    node_execution_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("node_executions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    input: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    output: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="succeeded | failed | timeout",
    )
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False)

    # Relationships
    tool: Mapped["Tool"] = relationship("Tool", back_populates="executions")
    node_execution: Mapped[Optional["NodeExecution"]] = relationship(  # type: ignore[name-defined]
        "NodeExecution", back_populates="tool_executions"
    )
