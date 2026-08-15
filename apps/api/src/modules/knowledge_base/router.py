"""
modules/knowledge_base/router.py — /api/v1/knowledge-bases

Route decorators, dependency injection, and a call to the service. No business
logic and no DB access (root CLAUDE.md's layering rule).

`organization_id` comes from `get_current_org` on every route and never from a
path, query or body — the knowledge base's own id in the path is scoped against
it inside the service.
"""

import uuid
from collections.abc import Sequence

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.dependencies import get_current_org, require_permission
from src.core.permissions import KNOWLEDGE_READ, KNOWLEDGE_WRITE
from src.db.database import get_db_session
from src.modules.knowledge_base.schemas import (
    ChunkSearchRequest,
    ChunkSearchResponse,
    DocumentChunkResponse,
    DocumentResponse,
    KnowledgeBaseCreate,
    KnowledgeBaseResponse,
    KnowledgeBaseUpdate,
    RetrievalHitResponse,
)
from src.modules.knowledge_base.service import EmptyQueryError, KnowledgeBaseService

router = APIRouter(tags=["knowledge-bases"])


def get_kb_service(db: AsyncSession = Depends(get_db_session)) -> KnowledgeBaseService:
    return KnowledgeBaseService(db)


# ---------------------------------------------------------------------------
# Knowledge bases
# ---------------------------------------------------------------------------


@router.post(
    "",
    response_model=KnowledgeBaseResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[require_permission(KNOWLEDGE_WRITE)],
)
async def create_knowledge_base(
    data: KnowledgeBaseCreate,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: KnowledgeBaseService = Depends(get_kb_service),
) -> KnowledgeBaseResponse:
    return await service.create_kb(organization_id, data)


@router.get("", response_model=Sequence[KnowledgeBaseResponse], dependencies=[require_permission(KNOWLEDGE_READ)])
async def list_knowledge_bases(
    workspace_id: uuid.UUID | None = Query(None, description="Restrict to one workspace."),
    cursor: str | None = Query(None, description="Cursor for pagination (ISO datetime string)"),
    limit: int = Query(50, ge=1, le=100),
    organization_id: uuid.UUID = Depends(get_current_org),
    service: KnowledgeBaseService = Depends(get_kb_service),
) -> Sequence[KnowledgeBaseResponse]:
    return await service.list_kbs(organization_id, workspace_id, cursor, limit)


@router.get("/{kb_id}", response_model=KnowledgeBaseResponse, dependencies=[require_permission(KNOWLEDGE_READ)])
async def get_knowledge_base(
    kb_id: uuid.UUID,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: KnowledgeBaseService = Depends(get_kb_service),
) -> KnowledgeBaseResponse:
    return await service.get_kb(organization_id, kb_id)


@router.patch("/{kb_id}", response_model=KnowledgeBaseResponse, dependencies=[require_permission(KNOWLEDGE_WRITE)])
async def update_knowledge_base(
    kb_id: uuid.UUID,
    data: KnowledgeBaseUpdate,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: KnowledgeBaseService = Depends(get_kb_service),
) -> KnowledgeBaseResponse:
    return await service.update_kb(organization_id, kb_id, data)


@router.delete("/{kb_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require_permission(KNOWLEDGE_WRITE)])
async def delete_knowledge_base(
    kb_id: uuid.UUID,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: KnowledgeBaseService = Depends(get_kb_service),
) -> None:
    await service.delete_kb(organization_id, kb_id)


# ---------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------


@router.post(
    "/{kb_id}/documents",
    response_model=DocumentResponse,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[require_permission(KNOWLEDGE_WRITE)],
)
async def upload_document(
    kb_id: uuid.UUID,
    response: Response,
    file: UploadFile = File(..., description="PDF, DOCX, Markdown or plain text."),
    organization_id: uuid.UUID = Depends(get_current_org),
    service: KnowledgeBaseService = Depends(get_kb_service),
) -> DocumentResponse:
    """
    Two success codes, and the difference is worth reading.

    **202** — the file was stored and ingestion is queued. The row exists but the
    document is not usable yet, so poll `status` until `indexed` or `failed`.

    **200** — this exact content is already indexed in this knowledge base, and
    the existing document is returned unchanged. Nothing was stored and nothing
    was embedded. Re-uploading an unchanged file is the ordinary case during
    development, and paying to embed it again is the cost control the 15-day plan
    asks for.
    """
    document, deduplicated = await service.upload_document(organization_id, kb_id, file)
    if deduplicated:
        response.status_code = status.HTTP_200_OK
    return document


@router.get(
    "/{kb_id}/documents",
    response_model=Sequence[DocumentResponse],
    dependencies=[require_permission(KNOWLEDGE_READ)],
)
async def list_documents(
    kb_id: uuid.UUID,
    cursor: str | None = Query(None, description="Cursor for pagination (ISO datetime string)"),
    limit: int = Query(50, ge=1, le=100),
    organization_id: uuid.UUID = Depends(get_current_org),
    service: KnowledgeBaseService = Depends(get_kb_service),
) -> Sequence[DocumentResponse]:
    return await service.list_documents(organization_id, kb_id, cursor, limit)


@router.get(
    "/{kb_id}/documents/{document_id}",
    response_model=DocumentResponse,
    dependencies=[require_permission(KNOWLEDGE_READ)],
)
async def get_document(
    kb_id: uuid.UUID,
    document_id: uuid.UUID,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: KnowledgeBaseService = Depends(get_kb_service),
) -> DocumentResponse:
    return await service.get_document(organization_id, kb_id, document_id)


@router.delete(
    "/{kb_id}/documents/{document_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[require_permission(KNOWLEDGE_WRITE)],
)
async def delete_document(
    kb_id: uuid.UUID,
    document_id: uuid.UUID,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: KnowledgeBaseService = Depends(get_kb_service),
) -> None:
    await service.delete_document(organization_id, kb_id, document_id)


@router.get(
    "/{kb_id}/documents/{document_id}/chunks",
    response_model=Sequence[DocumentChunkResponse],
    dependencies=[require_permission(KNOWLEDGE_READ)],
)
async def list_document_chunks(
    kb_id: uuid.UUID,
    document_id: uuid.UUID,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    organization_id: uuid.UUID = Depends(get_current_org),
    service: KnowledgeBaseService = Depends(get_kb_service),
) -> Sequence[DocumentChunkResponse]:
    """
    Offset-paginated, unlike the cursor-paginated lists elsewhere — chunks have a
    natural total order and all share a `created_at`, so a timestamp cursor
    cannot page them. Never returns the embedding; see `DocumentChunkResponse`.
    """
    return await service.list_chunks(organization_id, kb_id, document_id, offset, limit)


# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------


@router.post(
    "/{kb_id}/search",
    response_model=ChunkSearchResponse,
    dependencies=[require_permission(KNOWLEDGE_READ)],
)
async def search_knowledge_base(
    kb_id: uuid.UUID,
    data: ChunkSearchRequest,
    organization_id: uuid.UUID = Depends(get_current_org),
    service: KnowledgeBaseService = Depends(get_kb_service),
) -> ChunkSearchResponse:
    """
    Semantic search over one knowledge base — the retrieval playground's endpoint.

    POST rather than GET despite being read-only: the query is free text that
    would otherwise sit in a URL, and putting a user's question into a query
    string writes it to every access log and proxy in the path. It is gated on
    `knowledge:read` for the same reason — it returns chunk text that permission
    already exposes through the chunk reader.

    Each call embeds the query and is therefore billable, which is why the
    response carries `tokens` and `cost_usd` back to the caller.
    """
    try:
        result = await service.search(
            organization_id,
            kb_id,
            data.query,
            top_k=data.top_k,
            score_floor=data.score_floor,
        )
    except EmptyQueryError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    return ChunkSearchResponse(
        query=data.query,
        hits=[RetrievalHitResponse(**vars(hit)) for hit in result.hits],
        hit_count=len(result.hits),
        embedding_model=result.model,
        tokens=result.tokens,
        cost_usd=result.cost_usd,
    )
