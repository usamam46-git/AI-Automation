"""Notification delivery state + the notifications queue's first real consumer.

Revision ID: 20260823_notify
Revises: 20260823_tool_secrets
Create Date: 2026-08-23

`notifications` has existed since the initial schema and **nothing had ever
written a row**. `worker_notifications` has consumed `-Q notifications` with an
empty task registry since the same commit. Vol. 5's three HR workflows (§14
Leave Approval, §15 Payroll Validation, §16 Attendance) all terminate in a
`Notify` step, so a leave approval that approves and tells nobody was the whole
HR story until now.

The table as shipped could record that a notification EXISTS and whether a user
had read it, but not whether it was ever delivered. For `in_app` those are the
same event; for an outbound channel they are emphatically not — a Slack webhook
can 500 for an hour — and a notification whose delivery failed silently is worse
than one that was never queued.

`status` is deliberately NOT an enum type: the channel vocabulary in this table
is open (`in_app | email | whatsapp | slack | webhook`) and a Postgres enum
would need a migration to add a state. Same reasoning as `audit_logs.action`.
"""

import sqlalchemy as sa

from alembic import op

revision = "20260823_notify"
down_revision = "20260823_tool_secrets"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "notifications",
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default="pending",
            comment="pending | delivered | failed. Open vocabulary, not a PG enum — see the revision docstring.",
        ),
    )
    op.add_column(
        "notifications",
        sa.Column("delivered_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.add_column(
        "notifications",
        sa.Column(
            "error",
            sa.Text(),
            nullable=True,
            comment="Last delivery failure, truncated. Never carries the webhook URL's query string.",
        ),
    )
    # The delivery worker's only query: this org's undelivered rows, newest first.
    # Partial, because `delivered` rows are the overwhelming majority at rest and
    # are never scanned by it.
    op.create_index(
        "ix_notifications_pending",
        "notifications",
        ["organization_id", "created_at"],
        unique=False,
        postgresql_where=sa.text("status <> 'delivered'"),
    )


def downgrade() -> None:
    op.drop_index("ix_notifications_pending", table_name="notifications")
    op.drop_column("notifications", "error")
    op.drop_column("notifications", "delivered_at")
    op.drop_column("notifications", "status")
