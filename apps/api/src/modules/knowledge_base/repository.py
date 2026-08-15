"""
modules/knowledge_base/repository.py — data access for KBs, documents and chunks.

Tenant scoping differs per table, and the difference is the thing to get right:

- `knowledge_bases` and `documents` both carry a direct `organization_id` (both
  inherit TenantMixin) and are scoped on it directly, like `tools`.
- **`document_chunks` carries NO tenant column at all.** It is not in the RLS
  policy set either, because there is nothing for a policy to filter on. Every
  chunk query therefore joins `document_chunks -> documents` and filters on the
  document's `organization_id`. This is the one table in the schema where
  query-layer scoping is the ONLY defence, not defence plus RLS.
"""

import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Any

from sqlalchemy import Select, delete, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.knowledge_base.models import Document, DocumentChunk, KnowledgeBase

# Retrieval defaults (days 6-7). `TOP_K` matches the five-chunk RAG call the
# build plan's budget model is costed against.
#
# `SCORE_FLOOR` is empirical, not a guess: the day-1 embedding probe measured
# 0.51 cosine similarity for the AP clause that answered the query against 0.10
# for an unrelated clause in the same corpus. 0.3 sits in that gap. It is a
# floor on RELEVANCE, and returning nothing is a valid, useful answer — an agent
# told "no matching policy" can say so, whereas one handed a 0.1-similarity
# chunk will cheerfully reason from it.
DEFAULT_TOP_K = 5
DEFAULT_SCORE_FLOOR = 0.3
MAX_TOP_K = 20


def build_chunk_search_stmt(
    *,
    organization_id: uuid.UUID,
    knowledge_base_id: uuid.UUID,
    query_vector: Sequence[float],
    top_k: int,
) -> Select:
    """
    The vector-search statement, shared by the async and sync callers.

    There are two callers with irreconcilable session types — the retrieval API
    route (async) and the `knowledge_search` tool node (sync, because
    `tool_handler` runs inside a LangGraph superstep with nothing to await). The
    ranking, the tenant join and the ordering must be identical for both, so the
    statement is built once here and executed by whichever session the caller
    holds. Duplicating this query in two places is how the sync path quietly
    loses the `organization_id` filter.

    Three things that are load-bearing:

    - **The join through `documents` is the entire tenant defence.**
      `document_chunks` has no `organization_id` and is not in the RLS policy
      set, so a missing filter here is a silent cross-tenant read.
    - **ORDER BY is the raw cosine DISTANCE, not the similarity score.** pgvector
      matches an HNSW index on `<=>` ascending; ordering by `1 - distance`
      descending is algebraically identical and defeats the index, degrading to
      a sequential scan over every chunk in the org.
    - **The score floor is NOT applied here.** Filtering on the derived score in
      SQL would also cost the index. The caller trims the returned top-k in
      Python, where it is free — k is at most MAX_TOP_K rows.
    """
    distance = DocumentChunk.embedding.cosine_distance(query_vector)
    return (
        select(
            DocumentChunk.id,
            DocumentChunk.content,
            DocumentChunk.chunk_index,
            DocumentChunk.token_count,
            Document.id.label("document_id"),
            Document.file_name,
            (1 - distance).label("score"),
        )
        .join(Document, Document.id == DocumentChunk.document_id)
        .where(
            Document.organization_id == organization_id,
            Document.knowledge_base_id == knowledge_base_id,
        )
        .order_by(distance)
        .limit(top_k)
    )


class KnowledgeBaseRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    # ---------------------------------------------------------------- KBs

    async def create_kb(self, organization_id: uuid.UUID, data: dict) -> KnowledgeBase:
        kb = KnowledgeBase(organization_id=organization_id, **data)
        self.db.add(kb)
        await self.db.flush()
        return kb

    async def get_kb(self, organization_id: uuid.UUID, kb_id: uuid.UUID) -> KnowledgeBase | None:
        stmt = select(KnowledgeBase).where(
            KnowledgeBase.id == kb_id,
            KnowledgeBase.organization_id == organization_id,
        )
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def list_kbs(
        self,
        organization_id: uuid.UUID,
        workspace_id: uuid.UUID | None,
        cursor: str | None,
        limit: int,
    ) -> Sequence[KnowledgeBase]:
        stmt = select(KnowledgeBase).where(KnowledgeBase.organization_id == organization_id)
        if workspace_id is not None:
            stmt = stmt.where(KnowledgeBase.workspace_id == workspace_id)
        if cursor:
            stmt = stmt.where(KnowledgeBase.created_at < datetime.fromisoformat(cursor))
        stmt = stmt.order_by(desc(KnowledgeBase.created_at)).limit(limit)
        return (await self.db.execute(stmt)).scalars().all()

    async def delete_kb(self, kb: KnowledgeBase) -> None:
        """Hard delete. `documents` and `document_chunks` cascade via their FKs."""
        await self.db.delete(kb)
        await self.db.flush()

    # ---------------------------------------------------------- Documents

    async def create_document(self, organization_id: uuid.UUID, data: dict) -> Document:
        document = Document(organization_id=organization_id, **data)
        self.db.add(document)
        await self.db.flush()
        return document

    async def get_document(self, organization_id: uuid.UUID, document_id: uuid.UUID) -> Document | None:
        stmt = select(Document).where(
            Document.id == document_id,
            Document.organization_id == organization_id,
        )
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def find_indexed_by_hash(
        self,
        organization_id: uuid.UUID,
        kb_id: uuid.UUID,
        digest: str,
    ) -> Document | None:
        """
        An already-indexed document in this KB with identical content.

        Backs the upload-time deduplication, which is where the cost control
        actually bites: re-uploading the same policy PDF during development is a
        normal thing to do a dozen times, and each one is otherwise a fresh row,
        a fresh object and a fresh embedding bill. `ix_documents_kb_content_hash`
        exists for exactly this lookup.

        Restricted to `indexed` on purpose — a `failed` or still-`processing`
        twin has no chunks to reuse, so matching it would hand the caller a
        document that never becomes usable.
        """
        stmt = select(Document).where(
            Document.organization_id == organization_id,
            Document.knowledge_base_id == kb_id,
            Document.content_hash == digest,
            Document.status == "indexed",
        )
        return (await self.db.execute(stmt)).scalars().first()

    async def list_documents(
        self,
        organization_id: uuid.UUID,
        kb_id: uuid.UUID,
        cursor: str | None,
        limit: int,
    ) -> Sequence[Document]:
        stmt = select(Document).where(
            Document.organization_id == organization_id,
            Document.knowledge_base_id == kb_id,
        )
        if cursor:
            stmt = stmt.where(Document.created_at < datetime.fromisoformat(cursor))
        stmt = stmt.order_by(desc(Document.created_at)).limit(limit)
        return (await self.db.execute(stmt)).scalars().all()

    async def delete_document(self, document: Document) -> None:
        """Hard delete. `document_chunks` cascades via its FK."""
        await self.db.delete(document)
        await self.db.flush()

    # ------------------------------------------------------------- Chunks

    async def list_chunks(
        self,
        organization_id: uuid.UUID,
        document_id: uuid.UUID,
        offset: int,
        limit: int,
    ) -> Sequence[DocumentChunk]:
        """
        Chunks for one document, in document order.

        Scoped by joining through `documents` — `document_chunks` has no
        `organization_id` of its own, so omitting this join is a cross-tenant
        read with nothing else to catch it.

        Offset paginated, unlike every list endpoint elsewhere in this codebase.
        Chunks have a natural total order (`chunk_index`) and a bounded count per
        document, and the reader wants "chunk 40 onwards", not "the next page
        after this timestamp". Cursor pagination on `created_at` would be
        actively wrong here: a document's chunks are all inserted in one
        transaction and share a timestamp.
        """
        stmt = (
            select(DocumentChunk)
            .join(Document, Document.id == DocumentChunk.document_id)
            .where(
                DocumentChunk.document_id == document_id,
                Document.organization_id == organization_id,
            )
            .order_by(DocumentChunk.chunk_index)
            .offset(offset)
            .limit(limit)
        )
        return (await self.db.execute(stmt)).scalars().all()

    async def search_chunks(
        self,
        organization_id: uuid.UUID,
        knowledge_base_id: uuid.UUID,
        query_vector: Sequence[float],
        top_k: int,
    ) -> Sequence[Any]:
        """Execute `build_chunk_search_stmt` on this async session. Rows, not ORM objects."""
        stmt = build_chunk_search_stmt(
            organization_id=organization_id,
            knowledge_base_id=knowledge_base_id,
            query_vector=query_vector,
            top_k=top_k,
        )
        return (await self.db.execute(stmt)).all()

    async def count_chunks(self, document_id: uuid.UUID) -> int:
        stmt = select(func.count()).select_from(DocumentChunk).where(DocumentChunk.document_id == document_id)
        return int((await self.db.execute(stmt)).scalar_one())

    async def delete_chunks_for_document(self, document_id: uuid.UUID) -> None:
        """
        Drop every chunk for a document.

        Called at the start of a (re-)ingestion so the task is idempotent:
        `task_acks_late=True` means a redelivered task must not double-insert.
        """
        await self.db.execute(delete(DocumentChunk).where(DocumentChunk.document_id == document_id))
        await self.db.flush()
