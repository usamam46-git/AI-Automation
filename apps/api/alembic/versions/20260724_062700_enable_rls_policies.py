"""enable_rls_policies

Revision ID: 3c4d5e6f7a8b
Revises: 2b3c4d5e6f7a
Create Date: 2026-07-24 06:27:00.000000

"""
from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '3c4d5e6f7a8b'
down_revision: str | None = '2b3c4d5e6f7a'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


TABLES_WITH_ORG_ID = [
    "api_keys",
    "org_memberships",
    "workspaces",
    "workflows",
    "workflow_runs",
    "agents",
    "prompts",
    "tools",
    "knowledge_bases",
    "documents",
    "chats",
    "notifications",
    "audit_logs",
    "billing_accounts",
    "billing_usage_records",
    "integrations",
    "webhooks",
    "settings"
]


def upgrade() -> None:
    # 1. Enable RLS on all standard tenant tables
    for table in TABLES_WITH_ORG_ID:
        # Enable RLS
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;")
        # Create standard isolation policy
        # Force the policy to allow bypass for superusers/bypassrls roles, but 
        # normally restrict to the current_setting.
        # We use NULLIF and current_setting with missing_ok=true in case it's not set.
        op.execute(f"""
            CREATE POLICY tenant_isolation ON {table}
            AS PERMISSIVE FOR ALL
            USING (
                organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
            );
        """)

    # 2. Handle the 'roles' table specifically because system roles have organization_id = NULL
    op.execute("ALTER TABLE roles ENABLE ROW LEVEL SECURITY;")
    op.execute("""
        CREATE POLICY tenant_isolation ON roles
        AS PERMISSIVE FOR ALL
        USING (
            organization_id IS NULL 
            OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        );
    """)

    # NOTE: The 'organizations' table itself is the tenant root and does NOT have RLS enabled.
    # Users, agent_versions, agent_sessions, messages, etc. are accessed through 
    # their parent entities in the application layer, OR we can add explicit JOIN policies
    # if direct access is required, but Vol.2 §3.8 specifically targets tables with organization_id.


def downgrade() -> None:
    # 1. Disable RLS and drop policy on 'roles'
    op.execute("DROP POLICY IF EXISTS tenant_isolation ON roles;")
    op.execute("ALTER TABLE roles DISABLE ROW LEVEL SECURITY;")

    # 2. Disable RLS and drop policies on all standard tenant tables
    for table in TABLES_WITH_ORG_ID:
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON {table};")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY;")
