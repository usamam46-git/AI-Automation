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

from sqlalchemy import Select, delete, desc, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.knowledge_base.models import Document, DocumentChunk, KnowledgeBase
from src.modules.tools.models import Tool
from src.modules.workflows.models import Workflow, WorkflowNode, WorkflowVersion

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

#: How many candidates each retrieval leg contributes to the fusion, before the
#: fused list is trimmed to `top_k`.
#:
#: Fusing only the top_k of each leg would defeat the point: the chunk hybrid
#: search exists to rescue is one the dense leg ranks *poorly*, so it has to be
#: inside the candidate window to be rescued at all. 4x with a floor of 20 keeps
#: both legs cheap — the dense leg is an HNSW lookup and the lexical leg is a GIN
#: lookup, and neither cares about a window this size.
CANDIDATE_DEPTH_MULTIPLIER = 4
MIN_CANDIDATE_DEPTH = 20


def candidate_depth(top_k: int) -> int:
    """Per-leg candidate count for a requested `top_k`."""
    return max(MIN_CANDIDATE_DEPTH, top_k * CANDIDATE_DEPTH_MULTIPLIER)


#: The tsvector expression, which MUST match `ix_document_chunks_content_gin`
#: character for character or Postgres will not use the index.
#:
#: The index has shipped since the initial schema and went unqueried until
#: 2026-08-30. It is declared as `to_tsvector('english'::regconfig, content)`,
#: so the explicit regconfig cast below is not decoration — dropping it, or
#: passing a plain `'english'` string that renders as `text`, produces a
#: different expression and a sequential scan over every chunk in the org.
_CONTENT_TSVECTOR = func.to_tsvector(text("'english'::regconfig"), DocumentChunk.content)

#: An OR tsquery built from the caller's text.
#:
#: **OR, not AND, and this is the whole reason the lexical leg works.**
#: `plainto_tsquery` and `websearch_to_tsquery` both AND their terms, so a
#: natural question — "Can an employee approve their own expense claim?" — asks
#: for a chunk containing every one of `employe & approv & expens & claim` and
#: routinely matches nothing at all. Lexemes are taken from `to_tsvector` (so
#: they are stemmed and stopword-filtered exactly like the indexed side) and
#: OR-ed, which lets `ts_rank_cd` do the discriminating instead of the matcher.
#:
#: `quote_literal` wraps each lexeme, because a lexeme containing an apostrophe
#: is valid in a tsvector and a syntax error in a bare tsquery. A query whose
#: lexemes are all stopwords aggregates to NULL, `@@ NULL` is NULL, and the leg
#: returns nothing — the correct degradation, not an error.
_OR_TSQUERY_SQL = "(SELECT string_agg(quote_literal(lexeme), ' | ') " "FROM unnest(to_tsvector('english'::regconfig, :lexical_query)))::tsquery"


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


def build_chunk_lexical_search_stmt(
    *,
    organization_id: uuid.UUID,
    knowledge_base_id: uuid.UUID,
    query_vector: Sequence[float],
    query_text: str,
    top_k: int,
) -> Select:
    """
    The full-text leg of hybrid retrieval. Same columns as the dense statement.

    Added 2026-08-30. It exists because dense retrieval has one failure mode no
    amount of chunking fixes: **negation**. Asked "Can an employee approve their
    own expense claim?" against a policy saying "Employees must not approve their
    own expenses", the correct chunk did not reach the top 3 — a question and its
    prohibition sit apart in embedding space. That phrase is a near-literal
    lexical match, which is exactly what this leg is good at. Measured on the
    Afaqhims corpus before writing it; do not attribute that miss to chunk size.

    It is a SEPARATE statement rather than one clever query, deliberately:
    `build_chunk_search_stmt` must keep `ORDER BY <cosine distance>` with nothing
    else in the way or it stops using the HNSW index, and folding a second
    ranking into it is the most likely way for that to happen by accident.
    Fusing two ranked lists in Python is cheaper to read and cheaper to test.

    **It also computes the cosine score**, even though it orders by text rank.
    Every hit the service returns therefore carries a real, comparable `score`
    whichever leg found it, so nothing downstream has to understand fusion. The
    cost is a vector comparison over at most `candidate_depth` rows, which is
    not an index question at that size.

    The tenant join is identical to the dense leg's, and for the identical
    reason — `document_chunks` has no tenant column and this join is the only
    defence it has.
    """
    distance = DocumentChunk.embedding.cosine_distance(query_vector)
    tsquery = text(_OR_TSQUERY_SQL).bindparams(lexical_query=query_text)
    rank = func.ts_rank_cd(_CONTENT_TSVECTOR, tsquery)
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
            _CONTENT_TSVECTOR.op("@@")(tsquery),
        )
        .order_by(desc(rank))
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

    async def list_referencing_tool_names(self, organization_id: uuid.UUID, kb_id: uuid.UUID) -> Sequence[str]:
        """
        Names of live registry tools that search this knowledge base.

        Tool names rather than a count, because this one is actionable: the fix
        is to edit or delete those rows, and naming them saves the caller
        hunting through the registry. Soft-deleted tools are excluded — they
        cannot be resolved at run start, so they reference nothing that runs.
        """
        stmt = (
            select(Tool.name)
            .where(
                Tool.organization_id == organization_id,
                Tool.is_active.is_(True),
                Tool.tool_type == "knowledge_search",
                Tool.config["knowledge_base_id"].astext == str(kb_id),
            )
            .order_by(Tool.name)
        )
        return (await self.db.execute(stmt)).scalars().all()

    async def count_published_node_references(self, organization_id: uuid.UUID, kb_id: uuid.UUID) -> int:
        """
        How many nodes in *published* versions carry this KB inline.

        The direct analogue of `ToolRepository.count_published_references`, and
        it inherits both of that method's decisions: published versions are
        immutable, so their nodes can never be edited to drop the reference,
        while drafts are still being edited and blocking on one would make a
        knowledge base undeletable for as long as someone has a stale tab open.

        Registry-backed nodes carry only `tool_id` and are covered by
        `list_referencing_tool_names` instead — deleting the corpus under a
        reviewed tool breaks every node using it, not just the published ones.
        """
        stmt = (
            select(func.count(WorkflowNode.id))
            .join(WorkflowVersion, WorkflowVersion.id == WorkflowNode.workflow_version_id)
            .join(Workflow, Workflow.id == WorkflowVersion.workflow_id)
            .where(
                # workflow_versions/workflow_nodes have no organization_id of
                # their own — scope comes from the owning workflow.
                Workflow.organization_id == organization_id,
                WorkflowVersion.published_at.is_not(None),
                WorkflowNode.config["knowledge_base_id"].astext == str(kb_id),
            )
        )
        return (await self.db.execute(stmt)).scalar_one()

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

    async def search_chunks_lexical(
        self,
        organization_id: uuid.UUID,
        knowledge_base_id: uuid.UUID,
        query_vector: Sequence[float],
        query_text: str,
        top_k: int,
    ) -> Sequence[Any]:
        """Execute `build_chunk_lexical_search_stmt` on this async session."""
        stmt = build_chunk_lexical_search_stmt(
            organization_id=organization_id,
            knowledge_base_id=knowledge_base_id,
            query_vector=query_vector,
            query_text=query_text,
            top_k=top_k,
        )
        return (await self.db.execute(stmt)).all()

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
