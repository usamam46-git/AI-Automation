"""Organization members: pending invitations and the member:read permission.

Revision ID: 20260818_org_members
Revises: 20260815_kb_ingestion

Vol. 3 §10 — "Members | Invite/remove, role assignment table, pending-invite
status". Until now `org_memberships` was written by exactly one line in the
whole codebase (`AuthService.register`), so every user was the sole Owner of
their own organization and four of the five seeded roles had never been held.

Three changes:

1. `org_memberships.user_id` becomes NULLABLE, and `invited_email` is added.
   An invitation addressed to someone with no account yet has no user to point
   at, and it must still appear on the roster — the "pending-invite status" the
   blueprint asks for is a real row, not a separate concept. `invited_email`
   carries the address until the invitee registers.

   Every permission path already filters `status = 'active'`
   (`require_permission`, `AuthService.switch_org`), so a NULL-user row grants
   nothing anywhere. That was true before this migration and is why relaxing
   the column is safe.

2. `uq_org_pending_invite` — a PARTIAL unique index on
   `(organization_id, lower(invited_email)) WHERE user_id IS NULL`. The existing
   `uq_org_membership (organization_id, user_id)` cannot do this job: Postgres
   treats NULLs as distinct, so it permits unlimited pending invitations to the
   same address. `lower()` because an invitation to Bob@x.com and one to
   bob@x.com are the same invitation.

3. `member:read` granted to system Admin, Editor and Approver.
   `seed_roles.py` covers a fresh install; this covers databases already seeded.
   Both are needed — `seed_system_roles` only INSERTs a role that is missing and
   never updates one that exists, so editing that file alone has no effect on
   any database that has already booted once. Same pairing as
   20260815_kb_ingestion and 20260730_workflow_publish_perm.

   Viewer is untouched: it holds `"*:read"` and `member:read` is deliberately
   NOT in `WILDCARD_READ_EXEMPT`, so the wildcard reaches it. Knowing who your
   colleagues are is ordinary in-org information.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260818_org_members"
down_revision: str | None = "20260815_kb_ingestion"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PENDING_INVITE_INDEX = "uq_org_pending_invite"

# Full replacement lists rather than a jsonb append: the column is jsonb and
# these are the authoritative sets, so a re-run converges instead of
# accumulating duplicates. Kept byte-identical to seed_roles.py.
_ADMIN_PERMISSIONS = (
    '["workflow:read", "workflow:write", "workflow:publish", "workflow:execute", '
    '"workspace:read", "workspace:write", "agent:read", "agent:write", '
    '"prompt:read", "prompt:write", "tool:read", "tool:write", '
    '"knowledge:read", "knowledge:write", '
    '"execution:read", "execution:approve", "audit:read", '
    '"member:read", "member:invite", "member:remove"]'
)

_EDITOR_PERMISSIONS = (
    '["workflow:read", "workflow:write", "workspace:read", "workspace:write", '
    '"agent:read", "agent:write", "prompt:read", "prompt:write", '
    '"tool:read", "tool:write", "knowledge:read", "knowledge:write", '
    '"member:read"]'
)

_APPROVER_PERMISSIONS = '["execution:read", "execution:approve", "member:read"]'

_ROLE_UPDATE = sa.text(
    """
    UPDATE roles
    SET permissions = CAST(:permissions AS jsonb)
    WHERE name = :name AND is_system = true AND organization_id IS NULL
    """
)


def upgrade() -> None:
    op.alter_column("org_memberships", "user_id", existing_type=sa.dialects.postgresql.UUID(as_uuid=True), nullable=True)
    op.add_column(
        "org_memberships",
        sa.Column(
            "invited_email",
            sa.Text(),
            nullable=True,
            comment="Address the invitation was addressed to; null for memberships created at register.",
        ),
    )
    op.execute(f"CREATE UNIQUE INDEX {_PENDING_INVITE_INDEX} " "ON org_memberships (organization_id, lower(invited_email)) " "WHERE user_id IS NULL")

    conn = op.get_bind()
    conn.execute(_ROLE_UPDATE, {"name": "Admin", "permissions": _ADMIN_PERMISSIONS})
    conn.execute(_ROLE_UPDATE, {"name": "Editor", "permissions": _EDITOR_PERMISSIONS})
    conn.execute(_ROLE_UPDATE, {"name": "Approver", "permissions": _APPROVER_PERMISSIONS})


def downgrade() -> None:
    # Pending invitations must go before user_id can be NOT NULL again — they
    # are precisely the rows that have no user. Deleting them is correct rather
    # than destructive: an unaccepted invitation carries no history, and the
    # alternative is a migration that cannot run.
    op.execute("DELETE FROM org_memberships WHERE user_id IS NULL")
    op.execute(f"DROP INDEX IF EXISTS {_PENDING_INVITE_INDEX}")
    op.drop_column("org_memberships", "invited_email")
    op.alter_column("org_memberships", "user_id", existing_type=sa.dialects.postgresql.UUID(as_uuid=True), nullable=False)
    # Permissions are deliberately not reverted, matching 20260815_kb_ingestion:
    # dropping member:read would hide the roster from roles whose rows survive
    # the downgrade, and an extra permission string is inert if the routes are gone.
