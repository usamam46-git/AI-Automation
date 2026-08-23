"""Add tools.secrets_encrypted — AES-256-GCM credential storage for registry tools.

Revision ID: 20260823_tool_secrets
Revises: 20260818_org_members
Create Date: 2026-08-23

Until this migration, a registry tool's credential lived in `tools.config` as
plaintext JSONB — typically `{"headers": {"Authorization": "Bearer sk-live-..."}}`.
It never leaked over HTTP (`_audit_input` drops headers, and a tool node's output
carries `status_code`/`body` only), but it sat readable in the database, in every
`pg_dump`, and in any replica. `models.py` compounded it by describing the column
as holding an "auth reference", which implies a pointer to a secret rather than
the secret itself.

The BYOK OpenAI key has been encrypted at rest since 2026-08-06
(`integrations.credentials`, Vol. 2 §13). This closes the same gap for the tool
registry, reusing `core/encryption.py` verbatim rather than inventing a second
scheme.

Nullable with no backfill and no data migration: existing rows keep whatever they
have and continue to work unchanged. Moving a live credential out of `config` and
into `secrets` is an explicit author action (re-save the tool with a
`{{secrets.name}}` placeholder), because this migration cannot tell which of a
config's values is a secret and which is a header the API needs verbatim.

NOTE the operational consequence, the same one that applies to `integrations`:
these bytes are decryptable only with the CURRENT `INTEGRATION_ENCRYPTION_KEY`.
AES-GCM authenticates, so rotating that key does not degrade this column, it
destroys it — every stored tool secret becomes permanently unrecoverable and must
be re-entered by hand. See the root CLAUDE.md warning about `infra/.env`.
"""

import sqlalchemy as sa
from alembic import op

revision = "20260823_tool_secrets"
down_revision = "20260818_org_members"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tools",
        sa.Column(
            "secrets_encrypted",
            sa.LargeBinary(),
            nullable=True,
            comment="AES-256-GCM blob (nonce || ciphertext+tag) of a JSON object of secret name -> value. "
            "Referenced from `config` as {{secrets.<name>}} and substituted at run start. "
            "Never returned by the API; only the key names are exposed.",
        ),
    )


def downgrade() -> None:
    op.drop_column("tools", "secrets_encrypted")
