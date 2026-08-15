"""
modules/knowledge_base/service.py — business rules for knowledge bases.

The upload path is the interesting one, and its shape is deliberate: validate,
store the bytes, create the row at `uploaded`, enqueue, return 202. Extraction
and embedding happen on `worker_documents`, never in the request — a 40-page PDF
is seconds of parsing plus several embedding round-trips, and holding an HTTP
connection open for that would make the browser own a job the worker should.

Ordering inside the upload matters. Bytes go to MinIO BEFORE the row is
committed, because the reverse leaves a row pointing at an object that does not
exist — a document permanently stuck in `uploaded` that the worker cannot
process. An orphaned object with no row is the cheaper failure: it costs storage
and nothing else.
"""

import uuid
from collections.abc import Sequence

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core import storage
from src.core.document_text import (
    SUPPORTED_MIME_TYPES,
    UnsupportedDocumentError,
    content_hash,
    resolve_mime_type,
)
from src.modules.knowledge_base.models import Document, KnowledgeBase
from src.modules.knowledge_base.repository import KnowledgeBaseRepository
from src.modules.knowledge_base.schemas import KnowledgeBaseCreate, KnowledgeBaseUpdate
from src.modules.workspaces.models import Workspace

#: Hard ceiling on one upload, in bytes.
#:
#: A cost and memory bound, not a policy: the file is read fully into memory to
#: hash and store it, and chunk count scales with size, so an unbounded upload is
#: an unbounded embedding bill. 20 MB is far above any policy document — the
#: plan's reference corpus is 40-page PDFs at well under 1 MB.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


class KnowledgeBaseService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = KnowledgeBaseRepository(db)

    # ------------------------------------------------------------ helpers

    async def _require_workspace(self, organization_id: uuid.UUID, workspace_id: uuid.UUID) -> None:
        """404, never 403 — same shape as ToolService, and for the same reason:
        confirming a workspace exists in another org is itself a leak."""
        stmt = select(Workspace.id).where(
            Workspace.id == workspace_id,
            Workspace.organization_id == organization_id,
        )
        if (await self.db.execute(stmt)).scalar_one_or_none() is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found.")

    async def _require_kb(self, organization_id: uuid.UUID, kb_id: uuid.UUID) -> KnowledgeBase:
        kb = await self.repo.get_kb(organization_id, kb_id)
        if kb is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Knowledge base not found.")
        return kb

    async def _require_document(self, organization_id: uuid.UUID, kb_id: uuid.UUID, document_id: uuid.UUID) -> Document:
        await self._require_kb(organization_id, kb_id)
        document = await self.repo.get_document(organization_id, document_id)
        if document is None or document.knowledge_base_id != kb_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
        return document

    # ----------------------------------------------------- knowledge bases

    async def create_kb(self, organization_id: uuid.UUID, data: KnowledgeBaseCreate) -> KnowledgeBase:
        await self._require_workspace(organization_id, data.workspace_id)
        kb = await self.repo.create_kb(organization_id, data.model_dump())
        await self.db.commit()
        await self.db.refresh(kb)
        return kb

    async def list_kbs(
        self,
        organization_id: uuid.UUID,
        workspace_id: uuid.UUID | None,
        cursor: str | None,
        limit: int,
    ) -> Sequence[KnowledgeBase]:
        return await self.repo.list_kbs(organization_id, workspace_id, cursor, limit)

    async def get_kb(self, organization_id: uuid.UUID, kb_id: uuid.UUID) -> KnowledgeBase:
        return await self._require_kb(organization_id, kb_id)

    async def update_kb(self, organization_id: uuid.UUID, kb_id: uuid.UUID, data: KnowledgeBaseUpdate) -> KnowledgeBase:
        kb = await self._require_kb(organization_id, kb_id)
        changes = data.model_dump(exclude_unset=True)
        for field, value in changes.items():
            setattr(kb, field, value)
        await self.db.commit()
        await self.db.refresh(kb)
        return kb

    async def delete_kb(self, organization_id: uuid.UUID, kb_id: uuid.UUID) -> None:
        """
        Delete a KB, its documents, its chunks, and the stored objects.

        Object keys are collected BEFORE the rows go, since the key is derived
        from the row. Storage deletes come after the commit: a failure there
        leaves orphaned bytes, which is recoverable, whereas failing the request
        after the rows are gone would leave the caller thinking nothing happened.
        """
        kb = await self._require_kb(organization_id, kb_id)
        documents = await self.repo.list_documents(organization_id, kb_id, cursor=None, limit=10_000)
        keys = [doc.storage_path for doc in documents]

        await self.repo.delete_kb(kb)
        await self.db.commit()

        for key in keys:
            await self._best_effort_delete(key)

    # ----------------------------------------------------------- documents

    async def upload_document(
        self,
        organization_id: uuid.UUID,
        kb_id: uuid.UUID,
        upload: UploadFile,
    ) -> tuple[Document, bool]:
        """
        Store an upload and queue it for ingestion.

        Returns `(document, deduplicated)`. The flag is a return value rather
        than state on the service because the router needs it to choose a
        status code, and a per-request attribute would be a side channel that
        silently breaks the moment anything reuses a service instance.
        """
        kb = await self._require_kb(organization_id, kb_id)

        file_name = (upload.filename or "").strip()
        if not file_name:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A filename is required.")

        try:
            mime_type = resolve_mime_type(file_name, upload.content_type)
        except UnsupportedDocumentError as exc:
            # 415, not 422: the request is well-formed, the media type is not one
            # we can process. Lists what IS accepted so the caller can act.
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail=f"{exc} Supported types: {', '.join(sorted(SUPPORTED_MIME_TYPES))}.",
            ) from exc

        data = await upload.read()
        if not data:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="The uploaded file is empty.")
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"File is {len(data)} bytes; the limit is {MAX_UPLOAD_BYTES}.",
            )

        # Deduplicate BEFORE storing anything. The 15-day plan's cost control is
        # "skip re-embedding unchanged files", and the case that actually costs
        # money is re-uploading the same document during development — each one
        # would otherwise be a new row, a new stored object and a full embedding
        # pass. Hashing here is free: the bytes are already in memory.
        #
        # Returning the existing document is more honest than creating a twin:
        # the caller's intent ("this file should be in this KB") is already
        # satisfied. The router downgrades 202 to 200 so the difference between
        # "queued" and "already there" is visible.
        digest = content_hash(data)
        duplicate = await self.repo.find_indexed_by_hash(organization_id, kb.id, digest)
        if duplicate is not None:
            return duplicate, True

        # The id is minted here rather than left to the DB default because the
        # storage key contains it, and the bytes are written before the row.
        document_id = uuid.uuid4()
        key = storage.object_key(organization_id, kb.id, document_id, file_name)

        try:
            await storage.put_object(key, data, mime_type)
        except storage.StorageError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Could not store the uploaded file: {exc}",
            ) from exc

        document = await self.repo.create_document(
            organization_id,
            {
                "id": document_id,
                "knowledge_base_id": kb.id,
                "file_name": file_name,
                "storage_path": key,
                "mime_type": mime_type,
                "status": "uploaded",
            },
        )
        await self.db.commit()
        await self.db.refresh(document)

        # Enqueued only after the commit — the worker loads the row by id, and a
        # task that overtakes its own transaction finds nothing there.
        from src.workers.document_tasks import ingest_document

        ingest_document.delay(str(document.id))
        return document, False

    async def list_documents(
        self,
        organization_id: uuid.UUID,
        kb_id: uuid.UUID,
        cursor: str | None,
        limit: int,
    ) -> Sequence[Document]:
        await self._require_kb(organization_id, kb_id)
        return await self.repo.list_documents(organization_id, kb_id, cursor, limit)

    async def get_document(self, organization_id: uuid.UUID, kb_id: uuid.UUID, document_id: uuid.UUID) -> Document:
        return await self._require_document(organization_id, kb_id, document_id)

    async def delete_document(self, organization_id: uuid.UUID, kb_id: uuid.UUID, document_id: uuid.UUID) -> None:
        document = await self._require_document(organization_id, kb_id, document_id)
        key = document.storage_path
        await self.repo.delete_document(document)
        await self.db.commit()
        await self._best_effort_delete(key)

    async def list_chunks(
        self,
        organization_id: uuid.UUID,
        kb_id: uuid.UUID,
        document_id: uuid.UUID,
        offset: int,
        limit: int,
    ) -> Sequence:
        await self._require_document(organization_id, kb_id, document_id)
        return await self.repo.list_chunks(organization_id, document_id, offset, limit)

    # -------------------------------------------------------------- internal

    async def _best_effort_delete(self, key: str) -> None:
        """
        Remove stored bytes without letting storage failures fail the request.

        The rows are already gone and committed at every call site. Raising here
        would report failure for an operation that succeeded, and the caller
        would retry a delete that now 404s. Orphaned bytes are a housekeeping
        problem; a phantom error is a correctness one.
        """
        import logging

        try:
            await storage.delete_object(key)
        except storage.StorageError:
            logging.getLogger(__name__).warning(
                "Rows for '%s' were deleted but the stored object could not be removed; it is now orphaned.",
                key,
            )
