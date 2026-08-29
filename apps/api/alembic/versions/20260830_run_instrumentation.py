"""Run instrumentation: per-node timing, and Test-step runs.

Revision ID: 20260830_run_instr
Revises: 20260823_notify
Create Date: 2026-08-30

Four columns, all additive and all nullable-or-defaulted, so an existing run
history stays valid and readable exactly as it is.

`node_executions.started_at` / `completed_at`
    Real per-node wall clock. `latency_ms` alone was measured in the stream loop,
    which can only time a whole SUPERSTEP — two nodes running in one step were
    reported with an identical duration, both counted from the end of the
    previous step. These are stamped by the compiler's instrumentation wrapper
    around the handler itself. They stay NULL for rows written before this
    migration, and for any node that produced no timing.

`workflow_runs.is_test` / `test_until_node_key`
    The builder's Test step. It is a REAL run — same worker, same engine, same
    quota, same money, same audit row — flagged only so the Executions list is
    not filled with the probes an author fires while wiring a node up, and
    carrying the node it was asked to stop after. `is_test` is NOT NULL with a
    server default of false: every run that already exists is a production run,
    and a nullable flag would make "is this a test" a three-valued question.
"""

import sqlalchemy as sa

from alembic import op

revision = "20260830_run_instr"
down_revision = "20260823_notify"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "node_executions",
        sa.Column(
            "started_at",
            sa.TIMESTAMP(timezone=True),
            nullable=True,
            comment=(
                "Measured by the compiler's instrumentation wrapper around the handler, not by "
                "the stream loop — the loop can only time a whole superstep."
            ),
        ),
    )
    op.add_column(
        "node_executions",
        sa.Column("completed_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.add_column(
        "workflow_runs",
        sa.Column(
            "is_test",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
            comment=(
                "A Test-step run started from the builder. A real run in every respect; flagged "
                "only so the Executions list is not filled with them, and it may be pinned to a "
                "DRAFT version, which an ordinary run never is."
            ),
        ),
    )
    op.add_column(
        "workflow_runs",
        sa.Column(
            "test_until_node_key",
            sa.Text(),
            nullable=True,
            comment="Test runs stop once this node has produced its output. NULL runs to the end.",
        ),
    )

    # Partial index: the Executions list hides test runs by default, so the
    # common query is "org's runs WHERE NOT is_test, newest first". Partial
    # rather than a plain index on is_test — the false rows are the ones being
    # selected, and indexing the true ones would be dead weight.
    op.create_index(
        "ix_workflow_runs_org_created_not_test",
        "workflow_runs",
        ["organization_id", "created_at"],
        postgresql_where=sa.text("is_test = false"),
    )


def downgrade() -> None:
    op.drop_index("ix_workflow_runs_org_created_not_test", table_name="workflow_runs")
    op.drop_column("workflow_runs", "test_until_node_key")
    op.drop_column("workflow_runs", "is_test")
    op.drop_column("node_executions", "completed_at")
    op.drop_column("node_executions", "started_at")
