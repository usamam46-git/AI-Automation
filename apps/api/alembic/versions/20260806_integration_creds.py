"""Add BYOK credential columns to integrations.

Revision ID: 20260806_integration_creds
Revises: 20260803_widen_cost_precision
Create Date: 2026-08-06

Changes:
  1. integrations.type        text, not null (discriminator, e.g. 'openai_api_key')
  2. integrations.credentials bytea, nullable (AES-256-GCM encrypted secret)
  3. integrations.last_four   text, nullable (plaintext, masked-display only)
  4. uq_integrations_org_type unique constraint on (organization_id, type)

Additive only: no code path has ever written to `integrations` (stub model,
no service/router until this release), so `type` can go straight to NOT NULL
with no backfill step.
"""

import sqlalchemy as sa

from alembic import op

revision = "20260806_integration_creds"
down_revision = "20260803_widen_cost_precision"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("integrations", sa.Column("type", sa.Text(), nullable=False, comment="Integration type discriminator, e.g. 'openai_api_key'."))
    op.add_column(
        "integrations",
        sa.Column(
            "credentials",
            sa.LargeBinary(),
            nullable=True,
            comment="AES-256-GCM encrypted secret (nonce || ciphertext+tag). Never the raw value (Vol. 2 §13).",
        ),
    )
    op.add_column(
        "integrations",
        sa.Column("last_four", sa.Text(), nullable=True, comment="Last 4 characters of the raw secret, plaintext, for masked display only."),
    )
    op.create_unique_constraint("uq_integrations_org_type", "integrations", ["organization_id", "type"])


def downgrade() -> None:
    op.drop_constraint("uq_integrations_org_type", "integrations", type_="unique")
    op.drop_column("integrations", "last_four")
    op.drop_column("integrations", "credentials")
    op.drop_column("integrations", "type")
