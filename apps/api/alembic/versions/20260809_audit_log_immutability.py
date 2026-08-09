"""Enforce audit_logs append-only at the database layer, and grant audit:read to Admin.

Revision ID: 20260809_audit_immutable
Revises: 20260809_workflow_triggers
Create Date: 2026-08-09

Vol. 2 §13 §700 requires two independent controls on `audit_logs`:
  (a) no UPDATE/DELETE route at the application layer, and
  (b) "a Postgres trigger rejects UPDATE/DELETE at the database layer as well".

`modules/audit_logs/models.py` has claimed since the initial commit that (b) was
"created in the initial migration". It never was — there is no CREATE TRIGGER in
any migration before this one. This adds it, and the docstring is corrected in
the same release.

Two consequences worth knowing before touching this
---------------------------------------------------
1. **Hard-deleting an organization now FAILS.** `audit_logs.organization_id` is
   `ON DELETE CASCADE`, and a cascade is a DELETE, so it hits this trigger. No
   code path hard-deletes an org today (there is no route, and workspaces and
   workflows are soft-deleted), and "an org's audit trail cannot be erased by
   deleting the org" is the property §700 is asking for — so this is treated as
   correct, not as a bug to work around. A future GDPR-erasure path must be a
   deliberate, reviewed migration that drops the trigger, purges, and recreates
   it; it must not be a silent bypass.

2. **TRUNCATE is unaffected, by design.** PostgreSQL fires TRUNCATE triggers,
   not row-level UPDATE/DELETE triggers, on a TRUNCATE. The test suite's
   isolation fixture (`tests/conftest.py::_clean_database`) TRUNCATEs every
   public table around each test and therefore still works. No TRUNCATE trigger
   is added here: §700 names UPDATE and DELETE only, and adding one would break
   test isolation for no stated requirement.

Also grants `audit:read` to the seeded system Admin role, mirroring
20260730_workflow_publish_perm's idempotent full-list rewrite. Owner holds "*"
and needs no change; Viewer's "*:read" deliberately does NOT reach audit:read
(see WILDCARD_READ_EXEMPT in core/permissions.py).
"""

import sqlalchemy as sa

from alembic import op

revision = "20260809_audit_immutable"
down_revision = "20260809_workflow_triggers"
branch_labels = None
depends_on = None

# Kept as one JSON literal, matching 20260730_workflow_publish_perm's approach:
# a full rewrite is idempotent, whereas a jsonb array append would duplicate the
# entry on a re-run.
_ADMIN_PERMISSIONS_WITH_AUDIT = (
    '["workflow:read", "workflow:write", "workflow:publish", "workflow:execute", '
    '"workspace:read", "workspace:write", "agent:read", "agent:write", '
    '"prompt:read", "prompt:write", "tool:read", "tool:write", '
    '"execution:read", "execution:approve", "audit:read", '
    '"member:invite", "member:remove"]'
)

_ADMIN_PERMISSIONS_WITHOUT_AUDIT = (
    '["workflow:read", "workflow:write", "workflow:publish", "workflow:execute", '
    '"workspace:read", "workspace:write", "agent:read", "agent:write", '
    '"prompt:read", "prompt:write", "tool:read", "tool:write", '
    '"execution:read", "execution:approve", '
    '"member:invite", "member:remove"]'
)


def upgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
        RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION
                'audit_logs is append-only: % is not permitted on this table',
                TG_OP
                USING ERRCODE = 'restrict_violation';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    # BEFORE, so the row is never written; FOR EACH STATEMENT, because the
    # exception aborts the whole statement anyway and there is no reason to pay
    # per-row dispatch on a bulk attempt.
    op.execute(
        """
        CREATE TRIGGER audit_logs_reject_update
        BEFORE UPDATE ON audit_logs
        FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_log_mutation();
        """
    )
    op.execute(
        """
        CREATE TRIGGER audit_logs_reject_delete
        BEFORE DELETE ON audit_logs
        FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_log_mutation();
        """
    )

    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            UPDATE roles
            SET permissions = CAST(:permissions AS jsonb)
            WHERE name = 'Admin' AND is_system = true AND organization_id IS NULL
            """
        ),
        {"permissions": _ADMIN_PERMISSIONS_WITH_AUDIT},
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS audit_logs_reject_delete ON audit_logs;")
    op.execute("DROP TRIGGER IF EXISTS audit_logs_reject_update ON audit_logs;")
    op.execute("DROP FUNCTION IF EXISTS reject_audit_log_mutation();")

    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            UPDATE roles
            SET permissions = CAST(:permissions AS jsonb)
            WHERE name = 'Admin' AND is_system = true AND organization_id IS NULL
            """
        ),
        {"permissions": _ADMIN_PERMISSIONS_WITHOUT_AUDIT},
    )
