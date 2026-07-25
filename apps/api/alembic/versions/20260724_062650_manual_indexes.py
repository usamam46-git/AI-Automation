"""manual_indexes

Revision ID: 2b3c4d5e6f7a
Revises: 1a2b3c4d5e6f
Create Date: 2026-07-24 06:26:50.000000

"""
from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '2b3c4d5e6f7a'
down_revision: str | None = '1a2b3c4d5e6f'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. document_chunks: HNSW index for ANN semantic search
    op.execute("""
        CREATE INDEX ix_document_chunks_embedding_hnsw 
        ON document_chunks 
        USING hnsw (embedding vector_cosine_ops);
    """)

    # 2. document_chunks: GIN index for keyword search (hybrid search leg)
    op.execute("""
        CREATE INDEX ix_document_chunks_content_gin 
        ON document_chunks 
        USING GIN (to_tsvector('english', content));
    """)

    # 3. workflow_runs: composite index for "recent runs by status" dashboard queries
    op.execute("""
        CREATE INDEX ix_workflow_runs_org_status_time 
        ON workflow_runs (organization_id, status, created_at DESC);
    """)

    # 4. node_executions: composite index for timeline reconstruction
    op.execute("""
        CREATE INDEX ix_node_executions_run_node 
        ON node_executions (workflow_run_id, node_key);
    """)

    # 5. audit_logs: composite index for recent audit queries
    op.execute("""
        CREATE INDEX ix_audit_logs_org_time 
        ON audit_logs (organization_id, created_at DESC);
    """)

    # 6. api_keys: unique B-tree on hashed_key for O(1) lookup per request
    op.execute("""
        CREATE UNIQUE INDEX ix_api_keys_hashed_key 
        ON api_keys (hashed_key);
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_api_keys_hashed_key;")
    op.execute("DROP INDEX IF EXISTS ix_audit_logs_org_time;")
    op.execute("DROP INDEX IF EXISTS ix_node_executions_run_node;")
    op.execute("DROP INDEX IF EXISTS ix_workflow_runs_org_status_time;")
    op.execute("DROP INDEX IF EXISTS ix_document_chunks_content_gin;")
    op.execute("DROP INDEX IF EXISTS ix_document_chunks_embedding_hnsw;")
