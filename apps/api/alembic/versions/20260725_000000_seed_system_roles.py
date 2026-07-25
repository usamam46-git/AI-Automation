"""Seed system RBAC roles (idempotent).

Revision ID: 20260725_000000
Revises: 3c4d5e6f7a8b
Create Date: 2026-07-25

Inserts the 5 built-in system roles if they do not already exist.
Safe to run on every deploy via `alembic upgrade head`.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260725_000000"
down_revision: str | None = "3c4d5e6f7a8b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_SYSTEM_ROLES: list[tuple[str, str]] = [
    ("Owner", '["*"]'),
    (
        "Admin",
        '["workflow:read", "workflow:write", "agent:read", "agent:write", '
        '"prompt:read", "prompt:write", "tool:read", "tool:write", '
        '"execution:read", "execution:approve", "member:invite", "member:remove"]',
    ),
    (
        "Editor",
        '["workflow:read", "workflow:write", "agent:read", "agent:write", '
        '"prompt:read", "prompt:write", "tool:read", "tool:write"]',
    ),
    ("Approver", '["execution:read", "execution:approve"]'),
    ("Viewer", '["*:read"]'),
]

_INSERT_SQL = sa.text(
    """
    INSERT INTO roles (name, permissions, is_system, organization_id)
    SELECT :name, CAST(:permissions AS jsonb), true, NULL
    WHERE NOT EXISTS (
        SELECT 1 FROM roles
        WHERE name = :name AND is_system = true AND organization_id IS NULL
    );
    """
)


def upgrade() -> None:
    conn = op.get_bind()
    for name, permissions_json in _SYSTEM_ROLES:
        conn.execute(_INSERT_SQL, {"name": name, "permissions": permissions_json})


def downgrade() -> None:
    op.execute(
        """
        DELETE FROM roles
        WHERE is_system = true
          AND organization_id IS NULL
          AND name IN ('Owner', 'Admin', 'Editor', 'Approver', 'Viewer');
        """
    )
