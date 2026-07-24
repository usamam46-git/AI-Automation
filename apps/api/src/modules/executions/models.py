import datetime
"""
modules/executions/models.py — Workflow run execution tracking.

Vol. 2 §3.2 — Workflow Engine

Tables:
  workflow_runs    — one row per triggered execution of a workflow version
  node_executions  — one row per node invocation within a run (the audit trail)

Design notes:
- workflow_runs.organization_id is denormalized (duplicated from the
  workflow/workspace chain) to allow fast dashboard queries scoped to a
  tenant without multi-table JOINs.
- checkpoint_state stores the full LangGraph checkpoint so a run can be
  resumed after a human-approval interrupt or a worker restart.
- node_executions is append-only — every retry creates a new row (attempt
  column tracks the retry number), so the full execution history is preserved.
"""

import uuid
from typing import Optional

from sqlalchemy import ForeignKey, Integer, Numeric, Text
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.db.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class WorkflowRun(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """
    A single execution instance of a WorkflowVersion.

    status lifecycle:
      pending → running → [waiting_approval | completed | failed | cancelled]

    checkpoint_state is the latest LangGraph PostgresSaver checkpoint,
    stored as JSONB so the run can be resumed from any intermediate node.
    total_cost_usd is updated incrementally as node_executions complete.
    """

    __tablename__ = "workflow_runs"

    workflow_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workflow_versions.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
        comment="Pinned to the exact version that was running when this run started.",
    )
    # organization_id inherited from TenantMixin (denormalized for fast scoped queries)
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="pending",
        comment="pending | running | waiting_approval | completed | failed | cancelled",
    )
    trigger_payload: Mapped[Optional[dict]] = mapped_column(
        JSONB,
        nullable=True,
        comment="The raw input that triggered this run (webhook body, email data, etc.).",
    )
    checkpoint_state: Mapped[Optional[dict]] = mapped_column(
        JSONB,
        nullable=True,
        comment="Latest LangGraph checkpoint — full resumable state of the graph.",
    )
    current_node_key: Mapped[Optional[str]] = mapped_column(
        Text,
        nullable=True,
        comment="The node currently executing or last executed.",
    )
    started_at: Mapped[Optional[datetime.datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    completed_at: Mapped[Optional[datetime.datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    total_cost_usd: Mapped[Optional[float]] = mapped_column(
        Numeric(10, 4),
        nullable=True,
        default=0.0,
        comment="Running total of all node_executions.cost_usd for this run.",
    )
    error: Mapped[Optional[dict]] = mapped_column(
        JSONB,
        nullable=True,
        comment="Structured error detail if the run failed.",
    )

    # Relationships
    workflow_version: Mapped["WorkflowVersion"] = relationship(  # type: ignore[name-defined]
        "WorkflowVersion", back_populates="runs"
    )
    node_executions: Mapped[list["NodeExecution"]] = relationship(
        "NodeExecution", back_populates="workflow_run"
    )
    audit_logs: Mapped[list["AuditLog"]] = relationship(  # type: ignore[name-defined]
        "AuditLog",
        primaryjoin="and_(AuditLog.resource_type=='workflow_run', "
                    "foreign(AuditLog.resource_id)==WorkflowRun.id)",
        viewonly=True,
    )


class NodeExecution(UUIDMixin, TimestampMixin, Base):
    """
    Records the execution of a single node within a WorkflowRun.

    This is the primary audit-trail row — every attempt at every node
    (including retries, identified by `attempt`) is recorded here.
    The combination of (workflow_run_id, node_key, attempt) is effectively
    unique but not enforced by a DB constraint to avoid write contention.

    token / cost columns are nullable because non-LLM nodes (tools,
    conditions, human_approval gates) have no token usage.
    """

    __tablename__ = "node_executions"

    workflow_run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workflow_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    node_key: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="Matches workflow_nodes.node_key for this run's version.",
    )
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="succeeded | failed | skipped",
    )
    input: Mapped[Optional[dict]] = mapped_column(
        JSONB, nullable=True, comment="Input state snapshot passed to this node."
    )
    output: Mapped[Optional[dict]] = mapped_column(
        JSONB, nullable=True, comment="Output state snapshot produced by this node."
    )
    tokens_prompt: Mapped[Optional[int]] = mapped_column(
        Integer, nullable=True, comment="Prompt token count (LLM nodes only)."
    )
    tokens_completion: Mapped[Optional[int]] = mapped_column(
        Integer, nullable=True, comment="Completion token count (LLM nodes only)."
    )
    cost_usd: Mapped[Optional[float]] = mapped_column(
        Numeric(10, 4),
        nullable=True,
        comment="Computed cost for this node execution (LLM nodes only).",
    )
    latency_ms: Mapped[int] = mapped_column(
        Integer, nullable=False, comment="Wall-clock execution time in milliseconds."
    )
    attempt: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=1,
        comment="1 for first attempt, increments on Celery retry.",
    )

    # Relationships
    workflow_run: Mapped["WorkflowRun"] = relationship(
        "WorkflowRun", back_populates="node_executions"
    )
    tool_executions: Mapped[list["ToolExecution"]] = relationship(  # type: ignore[name-defined]
        "ToolExecution", back_populates="node_execution"
    )
