"""Make workflow triggers real: schedule dispatch state + webhook signing secret.

Revision ID: 20260809_workflow_triggers
Revises: 20260808_tools_module
Create Date: 2026-08-09

Background: `workflows.trigger_type` has existed since the initial schema and is
offered in the Builder's create dialog, but nothing has ever consumed it. Only
`manual` did anything (POST /workflows/{id}/run). Celery beat booted with an
empty schedule. This migration adds the three columns the schedule + webhook
trigger paths need.

Changes:
  1. workflows.next_run_at  timestamptz, nullable, INDEXED — the due-time the
     beat tick selects on (`workers/trigger_tasks.dispatch_due_schedules` runs
     `WHERE trigger_type='schedule' AND next_run_at <= now()` every minute).
     The index is the point of the column: without it that predicate is a
     sequential scan over every workflow in every org, once a minute, forever.
  2. workflows.last_triggered_at  timestamptz, nullable — observability only;
     no code branches on it. Set by both the schedule and webhook paths.
  3. workflows.webhook_secret_encrypted  bytea, nullable — AES-256-GCM
     ciphertext of the inbound HMAC signing secret.

     Why a column and not `trigger_config->>'secret'`, which is where the
     models.py docstring used to say it went: `trigger_config` is echoed
     verbatim by `WorkflowResponse`, so a secret placed there is returned by
     GET /workflows/{id} to anyone with `workflow:read`. A separate column that
     appears in no response schema cannot leak that way. It mirrors
     `integrations.credentials` exactly (LargeBinary, same encrypt_secret()).

     That same docstring specified a *hashed* secret, which is not
     implementable — HMAC verification is symmetric and needs the plaintext
     back. The docstring is corrected in this release.

Additive and nullable throughout; no backfill. Existing `schedule`-typed
workflows (if any were created through the UI while the type was decorative)
get next_run_at=NULL and are therefore ignored by the tick until their cron is
re-saved — deliberate, since a NULL cron cannot be scheduled anyway.
"""

import sqlalchemy as sa

from alembic import op

revision = "20260809_workflow_triggers"
down_revision = "20260808_tools_module"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "workflows",
        sa.Column(
            "next_run_at",
            sa.TIMESTAMP(timezone=True),
            nullable=True,
            comment=("Next due fire time for trigger_type='schedule'. Selected on by the " "beat tick; indexed. Null for every other trigger type."),
        ),
    )
    op.add_column(
        "workflows",
        sa.Column(
            "last_triggered_at",
            sa.TIMESTAMP(timezone=True),
            nullable=True,
            comment="Last time a trigger (schedule or webhook) enqueued a run for this workflow.",
        ),
    )
    op.add_column(
        "workflows",
        sa.Column(
            "webhook_secret_encrypted",
            sa.LargeBinary(),
            nullable=True,
            comment=(
                "AES-256-GCM ciphertext of the inbound webhook signing secret. "
                "Reversible by necessity — HMAC verification needs the plaintext. "
                "Never serialized into any response schema."
            ),
        ),
    )
    # Partial index: only schedule-triggered rows are ever probed, and they are a
    # small minority of the table. Keeps the index off manual/webhook workflows.
    op.create_index(
        "ix_workflows_next_run_at_due",
        "workflows",
        ["next_run_at"],
        unique=False,
        postgresql_where=sa.text("trigger_type = 'schedule' AND next_run_at IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_workflows_next_run_at_due", table_name="workflows")
    op.drop_column("workflows", "webhook_secret_encrypted")
    op.drop_column("workflows", "last_triggered_at")
    op.drop_column("workflows", "next_run_at")
