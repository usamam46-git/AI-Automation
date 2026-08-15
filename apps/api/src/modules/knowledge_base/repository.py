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

from sqlalchemy import delete, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.knowledge_base.models import Document, DocumentChunk, KnowledgeBase


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
