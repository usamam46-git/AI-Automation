"""add is_active to workspaces

Revision ID: workspaces_is_active
Revises: 20260725_000000
Create Date: 2026-07-27 17:00:00.000000

"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "workspaces_is_active"
down_revision = "20260725_000000"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("workspaces", sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False))


def downgrade() -> None:
    op.drop_column("workspaces", "is_active")
