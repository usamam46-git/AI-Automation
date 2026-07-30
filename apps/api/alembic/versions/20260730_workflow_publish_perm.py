"""Add workflow:publish to system Admin role (idempotent).

Revision ID: 20260730_workflow_publish_perm
Revises: workspaces_is_active
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260730_workflow_publish_perm"
down_revision: str | None = "workspaces_is_active"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ADMIN_PERMISSIONS = (
    '["workflow:read", "workflow:write", "workflow:publish", "agent:read", "agent:write", '
    '"prompt:read", "prompt:write", "tool:read", "tool:write", '
    '"execution:read", "execution:approve", "member:invite", "member:remove"]'
)


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            UPDATE roles
            SET permissions = CAST(:permissions AS jsonb)
            WHERE name = 'Admin' AND is_system = true AND organization_id IS NULL
            """
        ),
        {"permissions": _ADMIN_PERMISSIONS},
    )


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            UPDATE roles
            SET permissions = CAST(:permissions AS jsonb)
            WHERE name = 'Admin' AND is_system = true AND organization_id IS NULL
            """
        ),
        {
            "permissions": (
                '["workflow:read", "workflow:write", "agent:read", "agent:write", '
                '"prompt:read", "prompt:write", "tool:read", "tool:write", '
                '"execution:read", "execution:approve", "member:invite", "member:remove"]'
            )
        },
    )
