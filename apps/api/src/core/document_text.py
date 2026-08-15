"""
core/document_text.py — turn an uploaded file into embeddable chunks.

Pure functions: no database, no network, no object storage. That is why this
sits in `core/` beside `llm_client.py` rather than inside
`modules/knowledge_base/` — the module convention is exactly five files and has
no slot for a helper, and this is the code in the ingestion path most worth
testing hard, which is far easier when nothing has to be mocked to reach it.

Three jobs, in the order the pipeline needs them:

    content_hash(data)  -> the re-ingestion skip
    extract_text(...)   -> bytes to text, per format
    chunk_text(text)    -> text to embeddable windows

## No OCR, deliberately

`ocr_results` exists in the schema and will invite you to fill it. The 15-day
plan rules it out: scanned-document OCR needs Tesseract or a vision model and is
a multi-day detour that adds nothing a demo shows. The consequence is handled
rather than ignored — a PDF whose pages yield no extractable text raises
`UnextractableDocumentError` instead of producing zero chunks, because a
document that silently indexes to nothing is a knowledge base that quietly
answers "I don't know" forever.
"""

from __future__ import annotations

import hashlib
import io
import re
from dataclasses import dataclass
from functools import lru_cache

import tiktoken

# ---------------------------------------------------------------------------
# Accepted formats
# ---------------------------------------------------------------------------

MIME_PDF = "application/pdf"
MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
MIME_MARKDOWN = "text/markdown"
MIME_PLAIN = "text/plain"

SUPPORTED_MIME_TYPES: frozenset[str] = frozenset({MIME_PDF, MIME_DOCX, MIME_MARKDOWN, MIME_PLAIN})

# Browsers and curl are inconsistent about Markdown in particular, so the
# extension is the tie-breaker when the declared type is generic or absent.
_EXTENSION_MIME: dict[str, str] = {
    ".pdf": MIME_PDF,
    ".docx": MIME_DOCX,
    ".md": MIME_MARKDOWN,
    ".markdown": MIME_MARKDOWN,
    ".txt": MIME_PLAIN,
    ".text": MIME_PLAIN,
}


class DocumentTextError(RuntimeError):
    """Base for every failure in this module."""


class UnsupportedDocumentError(DocumentTextError):
    """The file type is not one we extract. Not retryable."""


class UnextractableDocumentError(DocumentTextError):
    """The type is supported but no text came out — a scan, or a corrupt file."""


def resolve_mime_type(file_name: str, declared: str | None) -> str:
    """
    Decide a file's type from its extension first, its declared type second.

    The extension wins because clients lie by omission far more often than by
    commission: `curl -F file=@policy.md` sends `application/octet-stream`, and
    several browsers send that for `.docx` too. A declared type is only consulted
    when the extension is unknown.
    """
    lowered = file_name.lower()
    for extension, mime in _EXTENSION_MIME.items():
        if lowered.endswith(extension):
            return mime

    if declared:
        base = declared.split(";")[0].strip().lower()
        if base in SUPPORTED_MIME_TYPES:
            return base

    raise UnsupportedDocumentError(
        f"'{file_name}' is not a supported document. Accepted: PDF, DOCX, Markdown, plain text. "
        "Scanned documents are not supported — there is no OCR step."
    )


# ---------------------------------------------------------------------------
# Hashing
# ---------------------------------------------------------------------------


def content_hash(data: bytes) -> str:
    """
    SHA-256 of the raw bytes, hex.

    Drives the re-ingestion skip: re-uploading an unchanged file must not pay to
    embed it again. Over raw bytes rather than extracted text on purpose — it is
    cheaper, and it is computed before extraction so an unchanged file skips the
    parse as well as the embedding.
    """
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExtractedDocument:
    text: str
    page_count: int | None


def _decode_text(data: bytes) -> str:
    """UTF-8, then Latin-1 as a never-fails fallback."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("latin-1", errors="replace")


def _extract_pdf(data: bytes) -> ExtractedDocument:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data))
        pages = [(page.extract_text() or "") for page in reader.pages]
    except (PdfReadError, OSError, ValueError) as exc:
        raise UnextractableDocumentError(f"Could not read PDF: {exc}") from exc

    # Page breaks are paragraph breaks for chunking purposes: joining with a
    # single newline would weld the last line of one page to the first of the
    # next and hide a real boundary from the paragraph packer.
    return ExtractedDocument(text="\n\n".join(pages), page_count=len(pages))


def _extract_docx(data: bytes) -> ExtractedDocument:
    import docx

    try:
        document = docx.Document(io.BytesIO(data))
    except Exception as exc:  # python-docx raises a wide range on malformed input
        raise UnextractableDocumentError(f"Could not read DOCX: {exc}") from exc

    blocks = [paragraph.text for paragraph in document.paragraphs]
    # Tables carry a lot of a policy document's actual content — thresholds,
    # approval limits, rates. Dropping them would silently lose the parts most
    # worth retrieving.
    for table in document.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells if cell.text.strip()]
            if cells:
                blocks.append(" | ".join(cells))

    # DOCX has no fixed pagination — it is laid out at render time — so
    # page_count stays None rather than being invented.
    return ExtractedDocument(text="\n\n".join(blocks), page_count=None)


def extract_text(data: bytes, mime_type: str, file_name: str) -> ExtractedDocument:
    """
    Extract text from a supported document, or raise.

    Raises `UnsupportedDocumentError` for a type we do not handle and
    `UnextractableDocumentError` when the type is right but nothing came out —
    the scanned-PDF case. Both are permanent: the ingestion task must not retry
    either.
    """
    if mime_type == MIME_PDF:
        extracted = _extract_pdf(data)
    elif mime_type == MIME_DOCX:
        extracted = _extract_docx(data)
    elif mime_type in {MIME_MARKDOWN, MIME_PLAIN}:
        extracted = ExtractedDocument(text=_decode_text(data), page_count=None)
    else:
        raise UnsupportedDocumentError(f"No extractor for '{mime_type}' ({file_name}).")

    if not extracted.text.strip():
        raise UnextractableDocumentError(
            f"'{file_name}' contains no extractable text. If it is a scanned document, it cannot be "
            "indexed — there is no OCR step in this pipeline."
        )
    return extracted


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------

# The encoding the text-embedding-3-* family uses. Counting with anything else
# would put our chunk sizes and the embedding endpoint's view of them out of
# step — tolerable at 500 tokens, not at a context limit.
_ENCODING_NAME = "cl100k_base"

DEFAULT_MAX_TOKENS = 500
DEFAULT_OVERLAP_TOKENS = 60

_PARAGRAPH_SPLIT = re.compile(r"\n\s*\n+")
_WHITESPACE_RUN = re.compile(r"[ \t]+")


@lru_cache(maxsize=1)
def _encoding() -> tiktoken.Encoding:
    """Cached — building an encoding reads and parses a vocabulary file."""
    return tiktoken.get_encoding(_ENCODING_NAME)


def count_tokens(text: str) -> int:
    return len(_encoding().encode(text))


@dataclass(frozen=True)
class TextChunk:
    index: int
    content: str
    token_count: int


def _normalise(text: str) -> str:
    """Collapse horizontal whitespace and trim lines; keep blank-line structure."""
    lines = [_WHITESPACE_RUN.sub(" ", line).strip() for line in text.replace("\r\n", "\n").split("\n")]
    return "\n".join(lines)


def _split_oversized(unit: str, max_tokens: int) -> list[str]:
    """
    Break one over-long paragraph on token boundaries.

    Reached by a paragraph that exceeds the window on its own — a wall-of-text
    contract clause, or a PDF page extracted without paragraph breaks. Splitting
    on tokens loses the semantic boundary, which is why it is the fallback and
    not the strategy.
    """
    encoding = _encoding()
    tokens = encoding.encode(unit)
    return [encoding.decode(tokens[start : start + max_tokens]) for start in range(0, len(tokens), max_tokens)]


def chunk_text(
    text: str,
    *,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
) -> list[TextChunk]:
    """
    Pack text into overlapping, token-bounded chunks on paragraph boundaries.

    Paragraph-first rather than a sliding token window: a window that cuts
    mid-sentence embeds a fragment whose meaning is not the meaning of either
    neighbour, and retrieval quality is what this whole phase exists to serve.
    An oversized paragraph falls back to a token split (see `_split_oversized`).

    `overlap_tokens` carries the tail of one chunk into the head of the next so a
    fact spanning a boundary is retrievable from both sides.

    **No chunk is ever empty or whitespace-only.** `LLMClient.embed()` raises on
    those, and it raises for the whole batch — one blank chunk would fail an
    entire document's ingestion.
    """
    if max_tokens < 1:
        raise ValueError(f"max_tokens must be >= 1, got {max_tokens}")
    if not 0 <= overlap_tokens < max_tokens:
        raise ValueError(f"overlap_tokens must be in [0, max_tokens), got {overlap_tokens} with max_tokens={max_tokens}")

    normalised = _normalise(text)
    units: list[str] = []
    for block in _PARAGRAPH_SPLIT.split(normalised):
        stripped = block.strip()
        if not stripped:
            continue
        if count_tokens(stripped) > max_tokens:
            units.extend(part for part in _split_oversized(stripped, max_tokens) if part.strip())
        else:
            units.append(stripped)

    chunks: list[TextChunk] = []
    current: list[str] = []
    current_tokens = 0

    def flush() -> None:
        nonlocal current, current_tokens
        if not current:
            return
        content = "\n\n".join(current).strip()
        if content:
            chunks.append(TextChunk(index=len(chunks), content=content, token_count=count_tokens(content)))
        # Carry the tail forward as overlap. Whole units only — slicing a unit
        # here would reintroduce the mid-sentence cut the packer just avoided.
        carried: list[str] = []
        carried_tokens = 0
        for unit in reversed(current):
            unit_tokens = count_tokens(unit)
            if carried_tokens + unit_tokens > overlap_tokens:
                break
            carried.insert(0, unit)
            carried_tokens += unit_tokens
        current = carried
        current_tokens = carried_tokens

    for unit in units:
        unit_tokens = count_tokens(unit)
        if current and current_tokens + unit_tokens > max_tokens:
            flush()
            # A single unit can exceed the window even after a flush when the
            # overlap tail is large; drop the tail rather than overflow.
            if current_tokens + unit_tokens > max_tokens:
                current, current_tokens = [], 0
        current.append(unit)
        current_tokens += unit_tokens

    if current:
        content = "\n\n".join(current).strip()
        if content:
            chunks.append(TextChunk(index=len(chunks), content=content, token_count=count_tokens(content)))

    return chunks
