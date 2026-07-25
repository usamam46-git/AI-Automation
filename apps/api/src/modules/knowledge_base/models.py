"""
modules/knowledge_base/models.py — Knowledge base, documents, OCR, and chunks.

Vol. 2 §3.4 — Knowledge Base & RAG

Tables:
  knowledge_bases  — named KB entity owned by a Workspace
  documents        — uploaded files tracked through the ingestion pipeline
  ocr_results      — per-page OCR output from the document processing pipeline
  document_chunks  — chunked text units with pgvector embeddings for hybrid search

Design notes (Vol. 2 §3.4 + §3.7):
- document_chunks.embedding is NOT NULL with Vector(1536) — every chunk must
  be embedded before it is available for RAG queries.
- Two indexes are created on document_chunks in the hand-written index migration:
    1. HNSW (vector_cosine_ops) on embedding  — for ANN semantic search
    2. GIN on to_tsvector('english', content) — for BM25 keyword search leg
  Together these power the hybrid search described in Vol. 4 §7.
- Documents move through a status pipeline:
    uploaded → processing → indexed | failed
"""

import uuid

from pgvector.sqlalchemy import Vector
from sqlalchemy import Float, ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.db.base import Base, TenantMixin, TimestampMixin, UUIDMixin


class KnowledgeBase(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """Named knowledge base owned by a Workspace."""

    __tablename__ = "knowledge_bases"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_model: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="text-embedding-3-large",
        comment="OpenAI embedding model used to embed chunks in this KB.",
    )

    # Relationships
    workspace: Mapped["Workspace"] = relationship(  # type: ignore[name-defined]
        "Workspace", back_populates="knowledge_bases"
    )
    documents: Mapped[list["Document"]] = relationship(
        "Document", back_populates="knowledge_base"
    )


class Document(UUIDMixin, TenantMixin, TimestampMixin, Base):
    """
    Tracks a single uploaded file through the ingestion pipeline.

    storage_path is the MinIO object key (e.g. "org-uuid/kb-uuid/filename.pdf").
    status transitions: uploaded → processing → indexed | failed.
    """

    __tablename__ = "documents"

    knowledge_base_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("knowledge_bases.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(Text, nullable=False)
    storage_path: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="MinIO object key, e.g. 'org-uuid/kb-uuid/invoice.pdf'.",
    )
    mime_type: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="uploaded",
        comment="uploaded | processing | indexed | failed",
    )
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Relationships
    knowledge_base: Mapped["KnowledgeBase"] = relationship(
        "KnowledgeBase", back_populates="documents"
    )
    ocr_results: Mapped[list["OCRResult"]] = relationship(
        "OCRResult", back_populates="document"
    )
    chunks: Mapped[list["DocumentChunk"]] = relationship(
        "DocumentChunk", back_populates="document"
    )


class OCRResult(UUIDMixin, TimestampMixin, Base):
    """
    Per-page OCR output produced by the document processing pipeline.

    structured_data is populated for document types where the OCR pipeline
    performs structured extraction (e.g., invoice fields extracted from a PDF).
    confidence is a 0–1 float from the OCR engine.
    """

    __tablename__ = "ocr_results"

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    page_number: Mapped[int] = mapped_column(Integer, nullable=False)
    raw_text: Mapped[str] = mapped_column(Text, nullable=False)
    structured_data: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment="Structured extraction result, e.g. invoice fields as JSON.",
    )
    confidence: Mapped[float] = mapped_column(
        Float,
        nullable=False,
        default=0.0,
        comment="OCR confidence score in [0, 1].",
    )

    # Relationships
    document: Mapped["Document"] = relationship("Document", back_populates="ocr_results")


class DocumentChunk(UUIDMixin, TimestampMixin, Base):
    """
    A single text chunk from a document, with its pgvector embedding.

    chunk_index is the 0-based order of this chunk within the document.
    embedding is NOT NULL — a chunk is only persisted after successful embedding.
    token_count is the number of tokens in `content` (used for context-window
    budget management during RAG retrieval).

    Indexes (created in the hand-written index migration):
      - HNSW on embedding (vector_cosine_ops) for ANN semantic search
      - GIN on to_tsvector('english', content) for BM25 keyword search
    """

    __tablename__ = "document_chunks"

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    chunk_index: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        comment="0-based position of this chunk within the document.",
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[list] = mapped_column(
        Vector(1536),
        nullable=False,
        comment="text-embedding-3-large vector (1536 dims). HNSW-indexed for ANN search.",
    )
    token_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        comment="Token count of `content` for RAG context-window budgeting.",
    )

    # Relationships
    document: Mapped["Document"] = relationship("Document", back_populates="chunks")
