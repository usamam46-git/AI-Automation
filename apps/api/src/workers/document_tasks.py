"""
workers/document_tasks.py — knowledge-base document ingestion.

The first task ever routed to `worker_documents`. That container has been in
`infra/docker-compose.yml` since the initial commit, consuming `-Q
document_processing` with an empty task registry — this module is what it was
waiting for.

Pipeline, per document:

    download -> hash -> [skip if unchanged] -> extract -> chunk -> embed -> insert

`documents.status` walks `uploaded -> processing -> indexed | failed`, which is
the contract `models.py` has documented since the initial schema and which
nothing implemented until now.

## The skip is the cost control, not an optimisation

If the bytes hash to what the row already carries AND chunks exist, the task
marks the document `indexed` and returns without extracting or embedding
anything. Re-ingesting is otherwise the easiest way to spend the sprint budget
by accident — the 15-day plan calls this out by name, and a re-upload during
development is a normal thing to do a dozen times.

## Retry discipline

Embedding costs money, so a retry that cannot succeed is a retry that bills.
`_NON_RETRYABLE` mirrors `graph_tasks._NON_RETRYABLE`: a scanned PDF or an
unknown embedding model fails permanently and immediately, while a MinIO blip or
a transient OpenAI error is worth another attempt.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from celery import Task
from celery.exceptions import MaxRetriesExceededError
from sqlalchemy import select
from sqlalchemy import update as sa_update
from sqlalchemy.orm import selectinload

from src.core import storage
from src.core.document_text import (
    DocumentTextError,
    UnextractableDocumentError,
    UnsupportedDocumentError,
    chunk_text,
    content_hash,
    extract_text,
)
from src.core.llm_client import LLMConfigurationError
from src.db.database import async_session_maker
from src.modules.knowledge_base.models import Document, DocumentChunk
from src.workers.async_bridge import run_async
from src.workers.celery_app import celery_app

logger = logging.getLogger(__name__)

#: Permanent failures — never retried, because no number of attempts changes them
#: and every attempt after the first can cost money.
_NON_RETRYABLE = (
    UnsupportedDocumentError,
    UnextractableDocumentError,
    DocumentTextError,
    LLMConfigurationError,
)

#: Texts per embedding request.
#:
#: Far below `LLMClient._MAX_EMBEDDING_BATCH` (2048), which is a hard refusal
#: rather than a target — `embed()` raises instead of splitting, because
#: splitting would make one EmbeddingResult span several HTTP calls. 96 chunks
#: at ~500 tokens is a request of comfortable size and keeps a failure's blast
#: radius to one batch.
EMBED_BATCH_SIZE = 96


async def _set_status(document_id: uuid.UUID, status: str, **fields: Any) -> None:
    async with async_session_maker() as session:
        await session.execute(sa_update(Document).where(Document.id == document_id).values(status=status, **fields))
        await session.commit()


async def _ingest(document_id: uuid.UUID) -> str:
    """Returns a short outcome string for the log line. Raises on failure."""
    async with async_session_maker() as session:
        stmt = select(Document).where(Document.id == document_id).options(selectinload(Document.knowledge_base))
        document = (await session.execute(stmt)).scalar_one_or_none()
        if document is None:
            # Deleted between enqueue and execution. Not an error: the user's
            # intent was to remove it, and raising would retry three times.
            return "skipped: document no longer exists"

        kb = document.knowledge_base
        organization_id = document.organization_id
        storage_path = document.storage_path
        file_name = document.file_name
        mime_type = document.mime_type
        stored_hash = document.content_hash
        embedding_model = kb.embedding_model

        existing_chunks = (
            await session.execute(select(DocumentChunk.id).where(DocumentChunk.document_id == document_id).limit(1))
        ).scalar_one_or_none()

    await _set_status(document_id, "processing", error=None)

    data = await storage.get_object(storage_path)
    digest = content_hash(data)

    # The skip. Both halves matter: an unchanged hash with no chunks means a
    # previous run stored the hash and then failed before inserting, and that
    # must re-ingest rather than be declared indexed.
    if stored_hash == digest and existing_chunks is not None:
        await _set_status(document_id, "indexed")
        return f"skipped: '{file_name}' unchanged (hash {digest[:12]}), no embedding spend"

    extracted = extract_text(data, mime_type, file_name)
    chunks = chunk_text(extracted.text)
    if not chunks:
        raise UnextractableDocumentError(f"'{file_name}' produced no chunks after extraction.")

    # BYOK, resolved exactly as workflow execution resolves it. Ingestion spends
    # on the org's behalf and must bill the org's own key when one is stored,
    # falling back to settings.OPENAI_API_KEY when it is not.
    from src.workers.graph_tasks import _resolve_llm_client_factory

    client_factory = await _resolve_llm_client_factory(organization_id)
    client = client_factory()

    vectors: list[list[float]] = []
    for start in range(0, len(chunks), EMBED_BATCH_SIZE):
        batch = chunks[start : start + EMBED_BATCH_SIZE]
        result = client.embed(texts=[c.content for c in batch], model=embedding_model)
        vectors.extend(result.vectors)

    if len(vectors) != len(chunks):
        # embed() aligns vectors to inputs by the API's own `index` field, so
        # this should be unreachable — but a silent misalignment attaches each
        # chunk's vector to a different chunk, which is invisible downstream and
        # the worst outcome available here.
        raise LLMConfigurationError(f"Embedded {len(vectors)} vectors for {len(chunks)} chunks.")

    async with async_session_maker() as session:
        # Delete-then-insert makes the task idempotent under `task_acks_late`:
        # a redelivered task replaces its own chunks instead of doubling them.
        from sqlalchemy import delete as sa_delete

        await session.execute(sa_delete(DocumentChunk).where(DocumentChunk.document_id == document_id))
        session.add_all(
            [
                DocumentChunk(
                    document_id=document_id,
                    chunk_index=chunk.index,
                    content=chunk.content,
                    embedding=vector,
                    token_count=chunk.token_count,
                )
                for chunk, vector in zip(chunks, vectors, strict=True)
            ]
        )
        await session.execute(
            sa_update(Document)
            .where(Document.id == document_id)
            .values(
                status="indexed",
                content_hash=digest,
                page_count=extracted.page_count,
                error=None,
            )
        )
        await session.commit()

    return f"indexed '{file_name}': {len(chunks)} chunks, model {embedding_model}"


@celery_app.task(
    bind=True,
    name="src.workers.document_tasks.ingest_document",
    max_retries=3,
    default_retry_delay=10,
    queue="document_processing",
)
def ingest_document(self: Task, document_id: str) -> str:
    """
    Extract, chunk and embed one uploaded document.

    Enqueued by `KnowledgeBaseService.upload_document` after its transaction
    commits — a task that overtakes its own row finds nothing to load.
    """
    doc_uuid = uuid.UUID(document_id)
    try:
        outcome = run_async(_ingest(doc_uuid))
        logger.info("ingest_document %s: %s", document_id, outcome)
        return outcome
    except _NON_RETRYABLE as exc:
        logger.warning("ingest_document %s failed permanently: %s", document_id, exc)
        run_async(_set_status(doc_uuid, "failed", error=str(exc)))
        raise
    except Exception as exc:
        try:
            # Retry first; only record `failed` once the attempts are exhausted,
            # so a transient blip does not flash a scary status at the user.
            raise self.retry(exc=exc)
        except MaxRetriesExceededError:
            logger.error("ingest_document %s exhausted retries: %s", document_id, exc)
            run_async(_set_status(doc_uuid, "failed", error=f"Ingestion failed after retries: {exc}"))
            raise
