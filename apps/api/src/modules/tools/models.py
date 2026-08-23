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
- config stores type-specific config (endpoint URL, method, headers). It is
  plaintext JSONB and is returned verbatim by the API, so it must never hold a
  credential: put those in `secrets_encrypted` (AES-256-GCM, same scheme as
  `integrations.credentials`) and reference them from config as
  `{{secrets.<name>}}`, which ToolService substitutes at run start. Before
  2026-08-23 this line read "auth reference", which implied a pointer and
  described a column that in practice held the raw bearer token.
  encrypted at the application layer for secrets (see Vol. 2 §13).
- is_mutating is a TYPED COLUMN, deviating from Vol. 4 §4.3, which says tools
  "are marked `is_mutating: true` in their config". Free-form JSONB fails open
  on a misspelled key (`is_mutation` reads as non-mutating and walks straight
  past the publish-time approval guardrail); a bool column cannot. Note this
  only closes the hole for workflow nodes that reference a `tool_id` — nodes
  carrying inline config still read the JSONB key and still fail open.
"""

import uuid
from typing import Optional

from sqlalchemy import Boolean, ForeignKey, Integer, LargeBinary, Text
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
    description: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        comment="Sent to the LLM as the function spec's description (Vol. 4 §4.2).",
    )
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
        comment="Type-specific config (endpoint URL, method, headers). Plaintext and API-visible — "
        "a credential belongs in secrets_encrypted, referenced here as {{secrets.<name>}}.",
    )
    secrets_encrypted: Mapped[bytes | None] = mapped_column(
        LargeBinary,
        nullable=True,
        comment="AES-256-GCM blob of {name: value} credentials referenced from config as {{secrets.<name>}}.",
    )
    is_mutating: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default="false",
        comment="True if the tool writes external state (ERP posts, payments). Vol. 4 §4.3.",
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
        server_default="true",
        comment="False = soft-deleted. Hard deletes are refused: tool_executions cascades.",
    )

    # Relationships
    workspace: Mapped["Workspace"] = relationship(  # type: ignore[name-defined]
        "Workspace", back_populates="tools"
    )
    executions: Mapped[list["ToolExecution"]] = relationship("ToolExecution", back_populates="tool")

    @property
    def secret_keys(self) -> list[str]:
        """
        Names of the stored secrets, for `ToolResponse`. Never their values.

        A model property rather than a service-built response for the same reason
        `Workflow.current_version_number` is one — every read path (list, detail,
        create, update) needs it, and `from_attributes` finds it here without four
        call sites remembering to add it.

        The import is deferred because `service.py` imports this module; the cycle
        is real, not stylistic. Decryption cost is a single AES-GCM open over a few
        hundred bytes, and `decode_secrets` returns {} rather than raising if the
        encryption key has been rotated — so a tools list still renders and the
        failure surfaces at run time, where it names the tool.
        """
        from src.modules.tools.service import decode_secrets

        return sorted(decode_secrets(self.secrets_encrypted))


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
