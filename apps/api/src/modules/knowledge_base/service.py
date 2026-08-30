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

import functools
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from src.core import storage
from src.core.document_text import (
    SUPPORTED_MIME_TYPES,
    UnsupportedDocumentError,
    content_hash,
    resolve_mime_type,
)
from src.core.llm_client import LLMClient, get_llm_client
from src.db.sync_database import get_sync_session_maker
from src.modules.knowledge_base.models import Document, KnowledgeBase
from src.modules.knowledge_base.repository import (
    DEFAULT_SCORE_FLOOR,
    DEFAULT_TOP_K,
    MAX_TOP_K,
    KnowledgeBaseRepository,
    build_chunk_lexical_search_stmt,
    build_chunk_search_stmt,
    candidate_depth,
)
from src.modules.knowledge_base.schemas import KnowledgeBaseCreate, KnowledgeBaseUpdate
from src.modules.workspaces.models import Workspace

#: Hard ceiling on one upload, in bytes.
#:
#: A cost and memory bound, not a policy: the file is read fully into memory to
#: hash and store it, and chunk count scales with size, so an unbounded upload is
#: an unbounded embedding bill. 20 MB is far above any policy document — the
#: plan's reference corpus is 40-page PDFs at well under 1 MB.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


@dataclass(frozen=True)
class RetrievalHit:
    """One retrieved chunk, carrying everything an agent needs to cite it."""

    document_id: uuid.UUID
    document_name: str
    chunk_index: int
    content: str
    score: float


@dataclass(frozen=True)
class RetrievalResult:
    """
    Hits plus the bookkeeping for the one embedding call that produced them.

    The cost is carried out of here rather than swallowed because a
    `knowledge_search` node reports it on the `node_usage` channel — a RAG run
    whose per-run cost omitted its retrieval spend would under-report, and
    per-run cost is a governance claim this product makes explicitly.
    """

    hits: list[RetrievalHit]
    model: str
    tokens: int
    cost_usd: float


def _to_hit(row: Any) -> RetrievalHit:
    return RetrievalHit(
        document_id=row.document_id,
        document_name=row.file_name,
        chunk_index=row.chunk_index,
        content=row.content,
        score=float(row.score),
    )


#: Reciprocal-rank-fusion constant. 60 is the value from the original RRF paper
#: and the one every implementation uses; it flattens the difference between
#: adjacent top ranks so a chunk that both legs like beats one that either leg
#: adores. Raising it flattens further, lowering it makes rank 1 dominate.
RRF_K = 60


def fuse_hybrid(
    dense_rows: Sequence[Any],
    lexical_rows: Sequence[Any],
    *,
    score_floor: float,
    top_k: int,
) -> list[RetrievalHit]:
    """
    Merge the two ranked legs into one list, best first.

    ## Why rank fusion and not score blending

    The two legs produce incomparable numbers: cosine similarity is bounded in
    [-1, 1] and calibrated, `ts_rank_cd` is unbounded and depends on document
    length and term density. Any weighted sum of them needs a normalisation that
    is a guess, and the guess silently decides retrieval quality. **RRF uses only
    the positions**, so nothing has to be normalised and the fusion cannot be
    wrong about a scale it never reads.

    ## The floor applies to the dense leg only

    This is the decision most worth understanding before changing anything here.
    `score_floor` is a statement about SEMANTIC similarity — the day-1 probe put
    an answering clause at 0.51 and an unrelated one at 0.10, and 0.3 sits in
    that gap. A literal phrase match is a different kind of evidence and does not
    have to clear that bar to be relevant; the negation case this whole leg
    exists for is precisely a chunk whose cosine score is mediocre. Filtering
    lexical hits by cosine would reintroduce the miss the leg was added to fix.

    So: a dense hit must clear the floor, a lexical hit is admitted on its text
    match, and a chunk found by both is admitted regardless. The returned `score`
    stays cosine similarity in every case, so callers, the retrieval playground's
    cutoff line and every stored `score_floor` keep meaning what they meant.

    ## Ordering

    Rank is 1-based per leg. A chunk in both legs sums both contributions, which
    is what makes agreement between the legs the strongest signal available. Ties
    break on cosine score, then on chunk index, so the output is deterministic —
    an unstable retrieval order makes an agent's answer irreproducible for
    reasons no one can see.
    """
    contributions: dict[Any, float] = {}
    rows_by_id: dict[Any, Any] = {}
    admitted: set[Any] = set()

    for rank, row in enumerate(dense_rows, start=1):
        rows_by_id[row.id] = row
        contributions[row.id] = contributions.get(row.id, 0.0) + 1.0 / (RRF_K + rank)
        if float(row.score) >= score_floor:
            admitted.add(row.id)

    for rank, row in enumerate(lexical_rows, start=1):
        rows_by_id.setdefault(row.id, row)
        contributions[row.id] = contributions.get(row.id, 0.0) + 1.0 / (RRF_K + rank)
        admitted.add(row.id)

    ordered = sorted(
        (rows_by_id[chunk_id] for chunk_id in admitted),
        key=lambda row: (-contributions[row.id], -float(row.score), row.chunk_index),
    )
    return [_to_hit(row) for row in ordered[:top_k]]


def _clamp_top_k(top_k: int | None) -> int:
    if top_k is None:
        return DEFAULT_TOP_K
    return max(1, min(int(top_k), MAX_TOP_K))


class EmptyQueryError(ValueError):
    """Raised for a blank search query, before any billable call is made."""


@dataclass(frozen=True)
class _QueryEmbedding:
    vector: list[float]
    model: str
    tokens: int
    cost_usd: float


def _embed_query(*, query: str, model: str, client_factory: Callable[..., LLMClient] | None = None) -> _QueryEmbedding:
    """
    Embed one search query. Synchronous — `LLMClient` deliberately is.

    The blank check is here rather than left to `embed()` so the failure is a
    named error at the boundary instead of an OpenAI 400 surfacing from three
    frames down, and so no request is billed for embedding whitespace.

    `client_factory` defaults to None and is resolved to `get_llm_client` HERE
    rather than in the signature. A `= get_llm_client` default binds the
    function object once at import, which silently defeats both monkeypatching
    in tests and any future re-binding of the module attribute.
    """
    text = (query or "").strip()
    if not text:
        raise EmptyQueryError("Search query is empty.")

    factory = client_factory or get_llm_client
    result = factory().embed(texts=[text], model=model)
    return _QueryEmbedding(
        vector=result.vectors[0],
        model=result.model,
        tokens=result.tokens,
        cost_usd=result.cost_usd,
    )


def search_knowledge_base_sync(
    *,
    organization_id: uuid.UUID,
    knowledge_base_id: uuid.UUID,
    query: str,
    top_k: int | None = None,
    score_floor: float | None = None,
    client_factory: Callable[..., LLMClient] | None = None,
    session_factory: Callable[[], Any] | None = None,
) -> RetrievalResult:
    """
    The synchronous twin of `KnowledgeBaseService.search`, for the tool node.

    It exists because `tool_handler` runs inside a LangGraph superstep: it is a
    sync function with no event loop to await on and no session handed to it.
    This is the same constraint that produced `ToolExecutionLogger`, and it
    takes the same answer — `src/db/sync_database.py`, a second psycopg2 engine
    pooled with NullPool. Do not "unify" this with the async path by running a
    loop inside the handler; a nested `asyncio.run` inside a LangGraph node
    deadlocks against the executor already driving the graph.

    `organization_id` is supplied by the caller from the run row and is never
    read from node config — a workflow author must not be able to point a
    retrieval node at another tenant's corpus by editing a UUID on the canvas.

    Raises `LookupError` when the KB does not exist **in this org**; the two
    cases are deliberately indistinguishable, matching the 404-never-403 rule
    the HTTP layer follows.
    """
    maker = session_factory or get_sync_session_maker()
    with maker() as session:
        kb = session.execute(
            select(KnowledgeBase).where(
                KnowledgeBase.id == knowledge_base_id,
                KnowledgeBase.organization_id == organization_id,
            )
        ).scalar_one_or_none()
        if kb is None:
            raise LookupError(f"Knowledge base {knowledge_base_id} not found.")

        embedded = _embed_query(query=query, model=kb.embedding_model, client_factory=client_factory)
        limit = _clamp_top_k(top_k)
        depth = candidate_depth(limit)
        dense_rows = session.execute(
            build_chunk_search_stmt(
                organization_id=organization_id,
                knowledge_base_id=knowledge_base_id,
                query_vector=embedded.vector,
                top_k=depth,
            )
        ).all()
        lexical_rows = session.execute(
            build_chunk_lexical_search_stmt(
                organization_id=organization_id,
                knowledge_base_id=knowledge_base_id,
                query_vector=embedded.vector,
                query_text=query,
                top_k=depth,
            )
        ).all()

    floor = DEFAULT_SCORE_FLOOR if score_floor is None else score_floor
    return RetrievalResult(
        hits=fuse_hybrid(dense_rows, lexical_rows, score_floor=floor, top_k=limit),
        model=embedded.model,
        tokens=embedded.tokens,
        cost_usd=embedded.cost_usd,
    )


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

        **Blocked with a 409 while anything still searches this corpus**, the
        same rule `ToolService.delete_tool` applies to a tool referenced by a
        published version, and for the same reason: `knowledge_base_id` is
        resolved at run time, so deleting it out from under a live reference
        converts a working workflow into a run-time failure nobody asked for.
        Retrieval has two kinds of reference and both are checked — a registry
        `knowledge_search` tool (named, since editing it is the fix) and a node
        carrying the id inline in a published version.
        """
        kb = await self._require_kb(organization_id, kb_id)
        await self._assert_unreferenced(organization_id, kb_id)
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

    # ------------------------------------------------------------ retrieval

    async def search(
        self,
        organization_id: uuid.UUID,
        kb_id: uuid.UUID,
        query: str,
        *,
        top_k: int | None = None,
        score_floor: float | None = None,
        client_factory: Callable[..., LLMClient] | None = None,
    ) -> RetrievalResult:
        """
        Semantic search over one knowledge base. Backs the retrieval playground.

        The query is embedded with **the KB's own `embedding_model`**, never a
        default. Comparing a query embedded by one model against a corpus built
        with another returns plausible cosine numbers and meaningless rankings,
        and nothing raises — `embed()` requires an explicit model for exactly
        this reason, and the authority is this row.

        **The org's BYOK key is resolved here when no factory is injected.** The
        node path gets its factory from `_resolve_llm_client_factory` at run
        start (Vol. 2 §13), so leaving this path on the bare `get_llm_client`
        made the playground the one retrieval surface that ignored the stored
        key — 500 `LLMConfigurationError` for any org running on BYOK, which is
        every org that has not set a server-wide `OPENAI_API_KEY`. Resolving to
        None when nothing is stored reproduces the pre-BYOK fallback exactly.
        """
        kb = await self._require_kb(organization_id, kb_id)
        factory = client_factory or await self._byok_client_factory(organization_id)
        result = await run_in_threadpool(
            _embed_query,
            query=query,
            model=kb.embedding_model,
            client_factory=factory,
        )
        limit = _clamp_top_k(top_k)
        depth = candidate_depth(limit)
        dense_rows = await self.repo.search_chunks(organization_id, kb_id, result.vector, depth)
        lexical_rows = await self.repo.search_chunks_lexical(organization_id, kb_id, result.vector, query, depth)
        floor = DEFAULT_SCORE_FLOOR if score_floor is None else score_floor
        return RetrievalResult(
            hits=fuse_hybrid(dense_rows, lexical_rows, score_floor=floor, top_k=limit),
            model=result.model,
            tokens=result.tokens,
            cost_usd=result.cost_usd,
        )

    # -------------------------------------------------------------- internal

    async def _assert_unreferenced(self, organization_id: uuid.UUID, kb_id: uuid.UUID) -> None:
        """
        409 if a registry tool or a published node still searches this KB.

        Tools are reported first and by name because that is the reference a
        user can act on directly; the node count is a fallback for inline
        configurations, where the fix is to publish a new version instead.
        """
        tool_names = await self.repo.list_referencing_tool_names(organization_id, kb_id)
        if tool_names:
            listed = ", ".join(f"'{name}'" for name in tool_names)
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"Cannot delete this knowledge base because {len(tool_names)} registry tool(s) search it: "
                    f"{listed}. Point them at another knowledge base or delete them first."
                ),
            )

        nodes = await self.repo.count_published_node_references(organization_id, kb_id)
        if nodes > 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Cannot delete this knowledge base because {nodes} node(s) in published workflow version(s) search it.",
            )

    async def _byok_client_factory(self, organization_id: uuid.UUID) -> Callable[..., LLMClient]:
        """
        The request-scoped twin of `graph_tasks._resolve_llm_client_factory`.

        Imported inside the call rather than at module scope: `integrations`
        pulls in `audit_logs` and the encryption layer, and this module is also
        imported by `node_handlers` (via `validate_tool_config`) into every
        process that merely validates a tool config — the same reasoning that
        keeps `_default_search`'s import local.
        """
        from src.modules.integrations.service import IntegrationService

        api_key = await IntegrationService(self.db).get_decrypted_openai_key(organization_id)
        return functools.partial(get_llm_client, api_key_override=api_key)

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
