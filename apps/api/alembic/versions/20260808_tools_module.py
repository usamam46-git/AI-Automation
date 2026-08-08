"""Promote the tools registry from a models-only stub to a real module.

Revision ID: 20260808_tools_module
Revises: 20260806_integration_creds
Create Date: 2026-08-08

Changes:
  1. tools.description  text, nullable — Vol. 2 §3.3's table omits it, but Vol. 4
     §4.2 calls a tool's description "a first-class prompt-engineering artifact"
     and OpenAI's function spec requires one. `agents` already has the column.
  2. tools.is_mutating  boolean, not null, default false — Vol. 4 §4.3 puts this
     in `config`; a typed column is a deliberate deviation so a misspelled key
     can't silently bypass the publish-time approval guardrail. See models.py.
  3. tools.is_active    boolean, not null, default true — no tool lifecycle is
     specified anywhere in the blueprint. Soft-delete is forced by
     tool_executions.tool_id being ON DELETE CASCADE: a hard delete would erase
     the very audit trail Vol. 4 §4.3 exists to create.
  4. uq_tools_workspace_name — Vol. 2 §7.2 says the registry IS the
     function-calling contract, and OpenAI requires function names to be unique
     within one `tools=` array. Without this the spec list is malformed by
     construction.
  5. tool_executions.status comment gains 'running', the intent-row state
     written before a call executes. No CHECK constraint exists on the column,
     so the comment is the only place the vocabulary is recorded.

Additive only. Nothing has ever written to `tools` or `tool_executions` (the
module was models-only until this release), so the NOT NULL columns can take
their server defaults with no backfill step.
"""

import sqlalchemy as sa

from alembic import op

revision = "20260808_tools_module"
down_revision = "20260806_integration_creds"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tools",
        sa.Column(
            "description",
            sa.Text(),
            nullable=True,
            comment="Sent to the LLM as the function spec's description (Vol. 4 §4.2).",
        ),
    )
    op.add_column(
        "tools",
        sa.Column(
            "is_mutating",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
            comment="True if the tool writes external state (ERP posts, payments). Vol. 4 §4.3.",
        ),
    )
    op.add_column(
        "tools",
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
            comment="False = soft-deleted. Hard deletes are refused: tool_executions cascades.",
        ),
    )
    op.create_unique_constraint("uq_tools_workspace_name", "tools", ["workspace_id", "name"])
    op.alter_column(
        "tool_executions",
        "status",
        existing_type=sa.Text(),
        existing_nullable=False,
        comment="running | succeeded | failed | timeout",
        existing_comment="succeeded | failed | timeout",
    )


def downgrade() -> None:
    op.alter_column(
        "tool_executions",
        "status",
        existing_type=sa.Text(),
        existing_nullable=False,
        comment="succeeded | failed | timeout",
        existing_comment="running | succeeded | failed | timeout",
    )
    op.drop_constraint("uq_tools_workspace_name", "tools", type_="unique")
    op.drop_column("tools", "is_active")
    op.drop_column("tools", "is_mutating")
    op.drop_column("tools", "description")
