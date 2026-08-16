/**
 * lib/knowledge.ts — pure helpers for the knowledge-base surfaces.
 *
 * Everything here is a pure function of its arguments so it can be unit-tested
 * without a React harness, matching the convention every other `lib/` module in
 * this app follows. Anything touching the DOM, React Query or the API client
 * belongs in the component, not here.
 */

import type { DocumentStatus, KnowledgeDocument } from "@/lib/api";

/**
 * MIME types the API's `SUPPORTED_MIME_TYPES` accepts.
 *
 * Kept in sync by hand with `apps/api/src/core/document_text.py`. Anything else
 * is a 415, so the dropzone rejects it client-side rather than spending a round
 * trip to be told no. **There is no image type here and that is deliberate** —
 * OCR is explicitly cut from the build plan, and accepting a scan we cannot
 * extract would index a document to zero chunks.
 */
export const ACCEPTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
] as const;

/** Mirrors `MAX_UPLOAD_BYTES` in the API's knowledge_base/service.py. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** The `accept` attribute for a file input — extensions, since browsers match on them. */
export const ACCEPT_ATTRIBUTE = ".pdf,.docx,.txt,.md";

export type UploadRejection = { file: string; reason: string };

/**
 * Split a dropped file list into what we will send and what we refuse.
 *
 * Client-side validation here is a courtesy, not a control: the server re-checks
 * both rules. The point is that a user dragging in a folder of twenty files
 * learns immediately which three are unsupported, instead of watching twenty
 * uploads and reading twenty toasts.
 */
export function partitionUploads(files: File[]): { accepted: File[]; rejected: UploadRejection[] } {
  const accepted: File[] = [];
  const rejected: UploadRejection[] = [];

  for (const file of files) {
    if (file.size === 0) {
      rejected.push({ file: file.name, reason: "File is empty" });
      continue;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      rejected.push({ file: file.name, reason: `Larger than ${formatBytes(MAX_UPLOAD_BYTES)}` });
      continue;
    }
    if (!isSupportedFile(file)) {
      rejected.push({ file: file.name, reason: "Unsupported file type" });
      continue;
    }
    accepted.push(file);
  }

  return { accepted, rejected };
}

/**
 * Accept on MIME type, falling back to the extension.
 *
 * The fallback is load-bearing rather than defensive: browsers routinely report
 * an empty `type` for `.md`, and on Windows `.txt` sometimes arrives as
 * `application/octet-stream`. Rejecting on MIME alone would refuse exactly the
 * Markdown policy documents this product is built to ingest.
 */
export function isSupportedFile(file: File): boolean {
  if ((ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) return true;
  return /\.(pdf|docx|txt|md|markdown)$/i.test(file.name);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Terminal states need no polling — the worker will not touch them again. */
export function isTerminalDocumentStatus(status: DocumentStatus): boolean {
  return status === "indexed" || status === "failed";
}

/** True while any document could still change, i.e. while the list must poll. */
export function hasPendingDocuments(documents: KnowledgeDocument[] | undefined): boolean {
  return Boolean(documents?.some((doc) => !isTerminalDocumentStatus(doc.status)));
}

export type StatusTone = "pending" | "active" | "success" | "danger";

export function documentStatusTone(status: DocumentStatus): StatusTone {
  switch (status) {
    case "indexed":
      return "success";
    case "failed":
      return "danger";
    case "processing":
      return "active";
    default:
      return "pending";
  }
}

export function documentStatusLabel(status: DocumentStatus): string {
  switch (status) {
    case "indexed":
      return "Indexed";
    case "failed":
      return "Failed";
    case "processing":
      return "Processing";
    default:
      return "Queued";
  }
}

/**
 * The rotating captions shown while a document is being ingested.
 *
 * They name the real pipeline stages in `document_tasks.py` rather than saying
 * "Loading" — the wait is genuinely several seconds and a user who can see
 * which stage is running can tell a slow embed from a stuck queue.
 */
export const INGESTION_CAPTIONS = ["Extracting text...", "Splitting into chunks...", "Embedding...", "Building the index..."];

export const RETRIEVAL_CAPTIONS = ["Embedding your question...", "Searching the index...", "Ranking passages..."];

/**
 * Similarity as a percentage string.
 *
 * Cosine similarity over unit vectors is in [-1, 1], and a negative score is
 * meaningful (opposed direction) but reads as nonsense in a UI, so it clamps at
 * zero. No decimal places: the precision implied by "63.7%" is not real, and
 * users compare these against each other rather than against a threshold.
 */
export function formatScore(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}

/** Cheap enough to be free in practice, but never render "$0.00" — it reads as broken. */
export function formatSearchCost(costUsd: number): string {
  if (costUsd <= 0) return "$0";
  if (costUsd < 0.01) return "<$0.01";
  return `$${costUsd.toFixed(2)}`;
}

/**
 * A short, human summary of a corpus.
 *
 * Returns null for an empty KB so the caller renders its empty state rather
 * than the technically-true but useless "0 documents".
 */
export function corpusSummary(documents: KnowledgeDocument[] | undefined): string | null {
  if (!documents?.length) return null;
  const indexed = documents.filter((doc) => doc.status === "indexed").length;
  const failed = documents.filter((doc) => doc.status === "failed").length;
  const parts = [`${documents.length} ${documents.length === 1 ? "document" : "documents"}`];
  if (indexed !== documents.length) parts.push(`${indexed} indexed`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

/**
 * Whether a KB can answer a query at all.
 *
 * Used to disable the playground with an explanation instead of letting someone
 * spend an embedding call on a corpus that structurally cannot return a hit.
 */
export function isSearchable(documents: KnowledgeDocument[] | undefined): boolean {
  return Boolean(documents?.some((doc) => doc.status === "indexed"));
}
