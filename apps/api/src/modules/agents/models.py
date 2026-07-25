"""
modules/agents/models.py — Agent definitions, versions, sessions, and memory.

Vol. 2 §3.3 — Agents, Tools, Prompts

Tables:
  agents          — the "shell" agent definition owned by a Workspace
  agent_versions  — versioned config snapshots (model, system prompt, tools, etc.)
  agent_sessions  — one session per agent invocation (standalone or within a run)
  agent_memory    — per-session memory entries with optional vector embedding

Design notes:
- agent_memory.embedding uses pgvector's Vector(1536) type for semantic
  memory retrieval — nullable because short_term and summary entries may
  not need an embedding.
- tool_ids on agent_versions is a JSONB array of Tool UUIDs — kept as JSONB
  rather than a proper join table to avoid a migration every time the
  agent builder adds/removes a tool (the tool registry validates refs at
  publish time).
"""

import uuid

from pgvector.sqlalchemy import Vector
from sqlalchemy import Float, ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.db.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Agent(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """
    Top-level agent entity owned by a Workspace.

    current_version_id mirrors the same pattern as Workflow — points to the
    live AgentVersion while allowing in-flight sessions to pin to the version
    they were started on.
    """

    __tablename__ = "agents"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_versions.id", ondelete="SET NULL", use_alter=True),
        nullable=True,
    )

    # Relationships
    workspace: Mapped["Workspace"] = relationship(  # type: ignore[name-defined]
        "Workspace", back_populates="agents"
    )
    versions: Mapped[list["AgentVersion"]] = relationship(
        "AgentVersion",
        back_populates="agent",
        foreign_keys="AgentVersion.agent_id",
    )
    sessions: Mapped[list["AgentSession"]] = relationship(
        "AgentSession", back_populates="agent"
    )


class AgentVersion(UUIDMixin, TimestampMixin, Base):
    """
    Immutable versioned configuration snapshot for an Agent.

    model: OpenAI model identifier (e.g. "gpt-4.1", "gpt-4.1-mini").
    system_prompt_id: FK to a Prompt — the agent's system prompt is managed
      via the prompt registry so it can be independently versioned and A/B tested.
    tool_ids: JSONB array of Tool UUIDs available to this agent version.
    max_iterations: hard safety bound on the ReAct tool-call loop.
    """

    __tablename__ = "agent_versions"

    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    system_prompt_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("prompts.id", ondelete="SET NULL"),
        nullable=True,
    )
    model: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="gpt-4.1-mini",
        comment="OpenAI model identifier, e.g. 'gpt-4.1', 'gpt-4.1-mini'.",
    )
    temperature: Mapped[float] = mapped_column(
        Float,
        nullable=False,
        default=0.0,
    )
    tool_ids: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="JSON array of Tool UUIDs bound to this agent version.",
    )
    max_iterations: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=10,
        comment="Hard cap on ReAct tool-call loop iterations.",
    )

    # Relationships
    agent: Mapped["Agent"] = relationship(
        "Agent", back_populates="versions", foreign_keys=[agent_id]
    )


class AgentSession(UUIDMixin, TimestampMixin, Base):
    """
    A single invocation context for an Agent.

    workflow_run_id is nullable — an agent can be invoked from within a
    workflow (linked to the run) or standalone via the Agent Playground.
    """

    __tablename__ = "agent_sessions"

    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    workflow_run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workflow_runs.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
        comment="Null if this session was started standalone (Agent Playground).",
    )
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="running",
        comment="running | completed | failed",
    )

    # Relationships
    agent: Mapped["Agent"] = relationship("Agent", back_populates="sessions")
    memory: Mapped[list["AgentMemory"]] = relationship(
        "AgentMemory", back_populates="agent_session"
    )


class AgentMemory(UUIDMixin, TimestampMixin, Base):
    """
    A single memory entry for an AgentSession.

    memory_type:
      - short_term      : recent message content, ephemeral
      - summary         : compressed summary of earlier turns
      - long_term_fact  : durable factual memory (persists across sessions)

    embedding is nullable — not all memory types need semantic retrieval.
    Vector(1536) matches the output dimension of text-embedding-3-large.
    The HNSW index on this column is created in the hand-written index migration.
    """

    __tablename__ = "agent_memory"

    agent_session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    memory_type: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="short_term | summary | long_term_fact",
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[list | None] = mapped_column(
        Vector(1536),
        nullable=True,
        comment="pgvector embedding for semantic memory retrieval (text-embedding-3-large).",
    )

    # Relationships
    agent_session: Mapped["AgentSession"] = relationship(
        "AgentSession", back_populates="memory"
    )
