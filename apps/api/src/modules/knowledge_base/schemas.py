"""
modules/knowledge_base/schemas.py — request/response contracts for KBs and documents.

Vol. 2 §9.2 documents no knowledge-base endpoints, so this surface is derived
from §9.1's conventions rather than transcribed: `/api/v1/{resource}`, cursor
pagination on `created_at`, and tenant scope taken from the authenticated
context and never from the request body.
"""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from src.core.llm_client import SUPPORTED_EMBEDDING_MODELS
from src.modules.knowledge_base.repository import MAX_TOP_K

#: What a new knowledge base gets when the caller does not choose.
#:
#: NOT the column default (`text-embedding-3-large`). Both models are requested
#: at 1536 dimensions by `LLMClient.embed()`, so they are interchangeable in the
#: schema and in the shared HNSW index — the only difference is price, and -small
#: is 6.5x cheaper ($0.02/M vs $0.13/M). The 15-day plan reserves -large for the
#: final demo corpus and -small for the development loop, where the same corpus
#: is re-indexed repeatedly. Switching a KB later costs a re-index, not a
#: migration.
DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"


class KnowledgeBaseCreate(BaseModel):
    """
    Deliberately has no `organization_id` — it comes from the authenticated
    context. A client-settable one is a bug (root CLAUDE.md).
    """

    workspace_id: uuid.UUID = Field(..., description="Owning workspace; must belong to the caller's org.")
    name: str = Field(..., min_length=1, max_length=200)
    embedding_model: str = Field(
        default=DEFAULT_EMBEDDING_MODEL,
        description="Embedding model for every chunk in this KB. Immutable after creation.",
    )

    @field_validator("embedding_model")
    @classmethod
    def _known_model(cls, value: str) -> str:
        """
        Reject anything `embed()` would not accept.

        `embedding_spec_for()` fails closed on an unknown model, so a free-text
        value here would create a knowledge base that raises on its first
        ingestion rather than at the moment someone made the typo.
        """
        if value not in SUPPORTED_EMBEDDING_MODELS:
            supported = ", ".join(sorted(SUPPORTED_EMBEDDING_MODELS))
            raise ValueError(f"'{value}' is not a supported embedding model. Choose one of: {supported}.")
        return value


class KnowledgeBaseUpdate(BaseModel):
    """
    `name` only — and the omissions are the point, not an oversight.

    `embedding_model` is absent because changing it invalidates every chunk
    already stored: cosine similarity across two embedding spaces returns
    plausible numbers and meaningless rankings, with nothing raising anywhere
    (see `LLMClient.embed`'s docstring). Re-embedding on the fly would be a
    silent, unbounded spend on a PATCH. `workspace_id` is absent because it is
    the row's tenancy anchor.

    `extra="forbid"` makes both a 422 rather than a silent no-op.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(None, min_length=1, max_length=200)


class KnowledgeBaseResponse(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    embedding_model: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DocumentResponse(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    knowledge_base_id: uuid.UUID
    file_name: str
    mime_type: str
    status: str = Field(..., description="uploaded | processing | indexed | failed")
    page_count: int | None = None
    content_hash: str | None = None
    error: str | None = Field(None, description="Set only when status is 'failed'.")
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DocumentChunkResponse(BaseModel):
    """
    One chunk, WITHOUT its embedding.

    `embedding` is 1536 floats. Serialising it would make a page of 50 chunks a
    multi-megabyte response carrying data no client can do anything with — the
    vector's only consumer is the cosine query inside Postgres. `token_count` is
    included because it is what the chunk inspector and the retrieval playground
    (days 8-9) actually need to show.
    """

    id: uuid.UUID
    document_id: uuid.UUID
    chunk_index: int
    content: str
    token_count: int

    model_config = ConfigDict(from_attributes=True)


class ChunkSearchRequest(BaseModel):
    """
    A retrieval query.

    Deliberately has no `embedding_model` — the model is the owning knowledge
    base's, and letting a caller choose per query would silently produce
    cross-model cosine scores that rank meaninglessly without raising.
    """

    model_config = ConfigDict(extra="forbid")

    query: str = Field(..., min_length=1, max_length=4000)
    top_k: int | None = Field(None, ge=1, le=MAX_TOP_K)
    #: 0 returns the raw top-k unfiltered, which is what makes the playground
    #: useful for calibrating the floor against a real corpus.
    score_floor: float | None = Field(None, ge=0.0, le=1.0)


class RetrievalHitResponse(BaseModel):
    """One ranked chunk. `document_name` and `chunk_index` are the citation."""

    document_id: uuid.UUID
    document_name: str
    chunk_index: int
    content: str
    score: float


class ChunkSearchResponse(BaseModel):
    """
    Ranked hits plus what the one embedding call cost.

    The cost is surfaced rather than hidden because the playground is a place a
    developer will run hundreds of queries while tuning, and each is billable.
    """

    query: str
    hits: list[RetrievalHitResponse]
    hit_count: int
    embedding_model: str
    tokens: int
    cost_usd: float
