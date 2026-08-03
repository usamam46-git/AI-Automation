"""Widen cost columns from numeric(10,4) to numeric(12,6).

Revision ID: 20260803_widen_cost_precision
Revises: 20260802_execution_engine
Create Date: 2026-08-03

Changes:
  1. node_executions.cost_usd  numeric(10,4) -> numeric(12,6)
  2. workflow_runs.total_cost_usd numeric(10,4) -> numeric(12,6)

Rationale:
  These columns start being populated with real values in this release (agent
  nodes now execute against OpenAI). At numeric(10,4) the scale is too coarse
  for the default model: a typical gpt-4.1-mini node call costs roughly
  $0.0002, and anything cheaper rounds to $0.0000 — per-node cost attribution
  would be mostly zeros. numeric(12,6) resolves down to a micro-dollar while
  still allowing totals up to $999,999.999999.

  Widening precision and scale is a non-destructive ALTER in PostgreSQL and
  requires no data rewrite of existing values.
"""

import sqlalchemy as sa

from alembic import op

revision = "20260803_widen_cost_precision"
down_revision = "20260802_execution_engine"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "node_executions",
        "cost_usd",
        existing_type=sa.Numeric(10, 4),
        type_=sa.Numeric(12, 6),
        existing_nullable=True,
        existing_comment="Computed cost for this node execution (LLM nodes only).",
    )
    op.alter_column(
        "workflow_runs",
        "total_cost_usd",
        existing_type=sa.Numeric(10, 4),
        type_=sa.Numeric(12, 6),
        existing_nullable=True,
    )


def downgrade() -> None:
    # LOSSY: narrowing the scale rounds any stored value to 4 decimal places.
    op.alter_column(
        "workflow_runs",
        "total_cost_usd",
        existing_type=sa.Numeric(12, 6),
        type_=sa.Numeric(10, 4),
        existing_nullable=True,
    )
    op.alter_column(
        "node_executions",
        "cost_usd",
        existing_type=sa.Numeric(12, 6),
        type_=sa.Numeric(10, 4),
        existing_nullable=True,
        existing_comment="Computed cost for this node execution (LLM nodes only).",
    )
