"""Knowledge-base ingestion: document content hash, failure reason, KB permissions.

Revision ID: 20260815_kb_ingestion
Revises: 20260809_audit_immutable

Three changes, all serving the days 2-5 ingestion pipeline:

1. `documents.content_hash` — sha256 of the uploaded bytes, with an index on
   (knowledge_base_id, content_hash). This is a COST CONTROL, not bookkeeping:
   re-uploading an unchanged file must skip extraction and embedding entirely,
   which is what keeps a fifteen-day iteration loop inside an $8 budget.

2. `documents.error` — why a document is in `failed`. The status column has
   existed since the initial schema with nowhere to record a reason, so a failed
   upload was undiagnosable through the API and the only recourse was reading
   worker logs.

3. `knowledge:read` / `knowledge:write` granted to system Admin and Editor.
   `seed_roles.py` covers a fresh install; this covers databases already seeded.
   Both are needed, exactly as with 20260730_workflow_publish_perm.

Viewer is untouched: it holds `"*:read"`, and `knowledge:read` is deliberately
NOT in WILDCARD_READ_EXEMPT, so the wildcard reaches it.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260815_kb_ingestion"
down_revision: str | None = "20260809_audit_immutable"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CONTENT_HASH_INDEX = "ix_documents_kb_content_hash"

# Full replacement lists rather than a jsonb append: the column is jsonb and
# these are the authoritative sets, so a re-run converges instead of accumulating
# duplicates. Kept byte-identical to seed_roles.py.
_ADMIN_PERMISSIONS = (
    '["workflow:read", "workflow:write", "workflow:publish", "workflow:execute", '
    '"workspace:read", "workspace:write", "agent:read", "agent:write", '
    '"prompt:read", "prompt:write", "tool:read", "tool:write", '
    '"knowledge:read", "knowledge:write", '
    '"execution:read", "execution:approve", "audit:read", '
    '"member:invite", "member:remove"]'
)

_EDITOR_PERMISSIONS = (
    '["workflow:read", "workflow:write", "workspace:read", "workspace:write", '
    '"agent:read", "agent:write", "prompt:read", "prompt:write", '
    '"tool:read", "tool:write", "knowledge:read", "knowledge:write"]'
)

_ROLE_UPDATE = sa.text(
    """
    UPDATE roles
    SET permissions = CAST(:permissions AS jsonb)
    WHERE name = :name AND is_system = true AND organization_id IS NULL
    """
)


def upgrade() -> None:
    op.add_column(
        "documents",
        sa.Column(
            "content_hash",
            sa.Text(),
            nullable=True,
            comment=(
                "sha256 hex of the uploaded bytes. Set once ingestion succeeds. A re-upload whose "
                "hash matches skips extraction and embedding — see workers/document_tasks.py."
            ),
        ),
    )
    op.add_column(
        "documents",
        sa.Column(
            "error",
            sa.Text(),
            nullable=True,
            comment="Why this document is in status='failed'. NULL in every other status.",
        ),
    )
    # Not unique: the same file legitimately appears in two knowledge bases, and
    # even within one KB a duplicate upload is a user action to answer, not a
    # constraint violation to raise from the database.
    op.create_index(_CONTENT_HASH_INDEX, "documents", ["knowledge_base_id", "content_hash"])

    conn = op.get_bind()
    conn.execute(_ROLE_UPDATE, {"name": "Admin", "permissions": _ADMIN_PERMISSIONS})
    conn.execute(_ROLE_UPDATE, {"name": "Editor", "permissions": _EDITOR_PERMISSIONS})


def downgrade() -> None:
    # Permissions are deliberately not reverted: dropping them would lock every
    # Admin and Editor out of knowledge bases whose rows survive the downgrade,
    # and an unused permission string is inert.
    op.drop_index(_CONTENT_HASH_INDEX, table_name="documents")
    op.drop_column("documents", "error")
    op.drop_column("documents", "content_hash")
