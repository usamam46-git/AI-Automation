"""Add interrupt_payload to workflow_runs and rejected status documentation.

Revision ID: 20260802_execution_engine
Revises: 20260730_workflow_publish_perm
Create Date: 2026-08-02

Changes:
  1. workflow_runs.interrupt_payload — nullable JSONB column.
     Populated when a run enters waiting_approval so the approval UI can
     read a typed payload without parsing LangGraph checkpoint internals
     (Vol. 3 §6.1, implementation Decision 13).

  Note: workflow_runs.status is a TEXT column with no SQL CHECK constraint;
  the 'rejected' terminal status is enforced at the application layer only.
  No DDL change is needed for status — only the model comment is updated.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "20260802_execution_engine"
down_revision = "20260730_workflow_publish_perm"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "workflow_runs",
        sa.Column(
            "interrupt_payload",
            JSONB,
            nullable=True,
            comment=(
                "Interrupt details from human_approval node — readable by the approval UI "
                "without parsing LangGraph checkpoint internals."
            ),
        ),
    )


def downgrade() -> None:
    op.drop_column("workflow_runs", "interrupt_payload")
