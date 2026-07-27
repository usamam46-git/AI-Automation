import datetime

"""
modules/workflows/models.py — Workflow engine models.

Vol. 2 §3.2 — Workflow Engine

Tables:
  workflows          — the "shell" definition (name, trigger config, current live version)
  workflow_versions  — versioned, immutable snapshot of the graph definition
  workflow_nodes     — individual nodes within a version (canvas positions + config)
  workflow_edges     — directed edges between nodes (with optional condition)

Design notes:
- A Workflow has a current_version_id FK that points to the "live" version.
- In-flight WorkflowRuns pin to the specific version they started on, so
  publishing a new version never breaks running executions.
- graph_definition (JSONB) on WorkflowVersion is the serialized node/edge
  graph compiled into a LangGraph StateGraph at execution time.
"""

import uuid

from sqlalchemy import Float, ForeignKey, Integer, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.db.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class Workflow(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """
    Top-level workflow entity owned by a Workspace.

    status lifecycle: draft → published → archived
    current_version_id points to the live WorkflowVersion (null while draft).
    trigger_config is a JSONB dict whose shape depends on trigger_type, e.g.:
      - schedule: {"cron": "0 9 * * 1-5"}
      - webhook:  {"secret": "<hashed_secret>"}
      - email:    {"inbox": "invoices@acme.aap.io"}
    """

    __tablename__ = "workflows"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="draft",
        comment="draft | published | archived",
    )
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workflow_versions.id", ondelete="SET NULL", use_alter=True),
        nullable=True,
        comment="Points to the currently live WorkflowVersion.",
    )
    trigger_type: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="manual",
        comment="manual | schedule | webhook | email | event",
    )
    trigger_config: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="Type-specific trigger configuration (cron, webhook secret, etc.).",
    )

    # Relationships
    workspace: Mapped["Workspace"] = relationship(  # type: ignore[name-defined]
        "Workspace", back_populates="workflows"
    )
    versions: Mapped[list["WorkflowVersion"]] = relationship(
        "WorkflowVersion",
        back_populates="workflow",
        foreign_keys="WorkflowVersion.workflow_id",
    )


class WorkflowVersion(UUIDMixin, TimestampMixin, Base):
    """
    Immutable, versioned snapshot of a workflow's graph definition.

    Once published (published_at is set), this row must not be mutated —
    any edit creates a new version.  In-flight runs reference this row
    by FK so they always execute on the exact graph they started with.

    graph_definition is the JSON representation compiled into a LangGraph
    StateGraph at execution time by apps/api/src/graphs/compiler.py.
    """

    __tablename__ = "workflow_versions"
    __table_args__ = (UniqueConstraint("workflow_id", "version_number", name="uq_workflow_version"),)

    workflow_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workflows.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version_number: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        comment="Monotonically increasing per workflow.",
    )
    graph_definition: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        comment="Full serialized node/edge graph — source of truth for LangGraph compilation.",
    )
    published_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    published_at: Mapped[datetime.datetime | None] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=True,
        comment="Null while this version is still a draft.",
    )

    # Relationships
    workflow: Mapped["Workflow"] = relationship(
        "Workflow",
        back_populates="versions",
        foreign_keys=[workflow_id],
    )
    nodes: Mapped[list["WorkflowNode"]] = relationship("WorkflowNode", back_populates="workflow_version")
    edges: Mapped[list["WorkflowEdge"]] = relationship("WorkflowEdge", back_populates="workflow_version")
    runs: Mapped[list["WorkflowRun"]] = relationship(  # type: ignore[name-defined]
        "WorkflowRun", back_populates="workflow_version"
    )


class WorkflowNode(UUIDMixin, TimestampMixin, Base):
    """
    A single node within a workflow version.

    node_key is a stable string identifier (e.g. "extract_invoice") referenced
    by edges and node_executions — it must be unique within a version.
    node_type determines how the graph compiler instantiates the node at runtime.
    position_x / position_y are canvas coordinates used by the React Flow UI.
    config is a type-specific JSONB dict (prompt_id, tool_id, condition expr, etc.).
    """

    __tablename__ = "workflow_nodes"

    workflow_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workflow_versions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    node_key: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="Stable string ID, unique within a version, e.g. 'extract_invoice'.",
    )
    node_type: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="agent | tool | condition | human_approval | subgraph | start | end",
    )
    config: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="Node-specific configuration (prompt_id, tool_id, condition expression, etc.).",
    )
    position_x: Mapped[float | None] = mapped_column(
        Float,
        nullable=True,
        comment="React Flow canvas X coordinate.",
    )
    position_y: Mapped[float | None] = mapped_column(
        Float,
        nullable=True,
        comment="React Flow canvas Y coordinate.",
    )

    # Relationships
    workflow_version: Mapped["WorkflowVersion"] = relationship("WorkflowVersion", back_populates="nodes")


class WorkflowEdge(UUIDMixin, TimestampMixin, Base):
    """
    A directed edge between two nodes within a workflow version.

    condition is an optional JSONB dict expressing a conditional-routing
    predicate, e.g.: {"when": "confidence < 0.8"}.
    Unconditional edges have condition = null.
    """

    __tablename__ = "workflow_edges"

    workflow_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workflow_versions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source_node_key: Mapped[str] = mapped_column(Text, nullable=False)
    target_node_key: Mapped[str] = mapped_column(Text, nullable=False)
    condition: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment='Conditional routing predicate, e.g. {"when": "confidence < 0.8"}.',
    )

    # Relationships
    workflow_version: Mapped["WorkflowVersion"] = relationship("WorkflowVersion", back_populates="edges")
