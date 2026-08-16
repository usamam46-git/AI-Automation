import { describe, expect, it } from "vitest";
import type { DocumentStatus, KnowledgeDocument } from "@/lib/api";
import {
  MAX_UPLOAD_BYTES,
  corpusSummary,
  documentStatusLabel,
  documentStatusTone,
  formatBytes,
  formatScore,
  formatSearchCost,
  hasPendingDocuments,
  isSearchable,
  isSupportedFile,
  isTerminalDocumentStatus,
  partitionUploads,
} from "@/lib/knowledge";

/** A File stand-in — jsdom's File is fine, but size needs to be forced. */
function file(name: string, { size = 1024, type = "" }: { size?: number; type?: string } = {}): File {
  const handle = new File(["x"], name, { type });
  Object.defineProperty(handle, "size", { value: size });
  return handle;
}

function doc(status: DocumentStatus, id: string = status): KnowledgeDocument {
  return {
    id,
    organization_id: "org",
    knowledge_base_id: "kb",
    file_name: `${id}.pdf`,
    mime_type: "application/pdf",
    status,
    page_count: null,
    content_hash: null,
    error: null,
    created_at: "2026-08-16T00:00:00Z",
    updated_at: "2026-08-16T00:00:00Z",
  };
}

describe("file acceptance", () => {
  it("accepts the four extractable formats by MIME type", () => {
    expect(isSupportedFile(file("a.pdf", { type: "application/pdf" }))).toBe(true);
    expect(isSupportedFile(file("a.txt", { type: "text/plain" }))).toBe(true);
  });

  it("falls back to the extension when the browser reports no MIME type", () => {
    // Browsers routinely report "" for .md, and Windows sometimes sends
    // application/octet-stream for .txt. Rejecting on MIME alone would refuse
    // exactly the Markdown policy docs this product exists to ingest.
    expect(isSupportedFile(file("policy.md", { type: "" }))).toBe(true);
    expect(isSupportedFile(file("policy.txt", { type: "application/octet-stream" }))).toBe(true);
  });

  it("rejects formats that need OCR, which is deliberately not built", () => {
    expect(isSupportedFile(file("scan.png", { type: "image/png" }))).toBe(false);
    expect(isSupportedFile(file("scan.jpg", { type: "image/jpeg" }))).toBe(false);
  });
});

describe("partitionUploads", () => {
  it("splits a mixed drop and explains every rejection", () => {
    const { accepted, rejected } = partitionUploads([
      file("good.pdf", { type: "application/pdf" }),
      file("empty.pdf", { size: 0, type: "application/pdf" }),
      file("huge.pdf", { size: MAX_UPLOAD_BYTES + 1, type: "application/pdf" }),
      file("photo.png", { type: "image/png" }),
    ]);

    expect(accepted.map((f) => f.name)).toEqual(["good.pdf"]);
    expect(rejected.map((r) => r.file)).toEqual(["empty.pdf", "huge.pdf", "photo.png"]);
    // Every rejection carries a reason a user can act on.
    expect(rejected.every((r) => r.reason.length > 0)).toBe(true);
  });

  it("accepts a file exactly at the size ceiling", () => {
    const { accepted } = partitionUploads([file("edge.pdf", { size: MAX_UPLOAD_BYTES, type: "application/pdf" })]);
    expect(accepted).toHaveLength(1);
  });
});

describe("polling control", () => {
  it("treats indexed and failed as terminal", () => {
    expect(isTerminalDocumentStatus("indexed")).toBe(true);
    expect(isTerminalDocumentStatus("failed")).toBe(true);
    expect(isTerminalDocumentStatus("uploaded")).toBe(false);
    expect(isTerminalDocumentStatus("processing")).toBe(false);
  });

  it("stops polling once every document has settled", () => {
    expect(hasPendingDocuments([doc("indexed"), doc("failed")])).toBe(false);
    expect(hasPendingDocuments([doc("indexed"), doc("processing")])).toBe(true);
    expect(hasPendingDocuments([])).toBe(false);
    expect(hasPendingDocuments(undefined)).toBe(false);
  });
});

describe("status presentation", () => {
  it("maps each status to a tone and a label", () => {
    expect(documentStatusTone("indexed")).toBe("success");
    expect(documentStatusTone("failed")).toBe("danger");
    expect(documentStatusTone("processing")).toBe("active");
    expect(documentStatusTone("uploaded")).toBe("pending");
    expect(documentStatusLabel("uploaded")).toBe("Queued");
  });
});

describe("formatScore", () => {
  it("renders similarity as a whole percentage", () => {
    expect(formatScore(0.5589)).toBe("56%");
    expect(formatScore(1)).toBe("100%");
  });

  it("clamps a negative cosine to zero rather than rendering '-12%'", () => {
    // Cosine over unit vectors is [-1, 1]; a negative score is meaningful but
    // reads as nonsense in a results list.
    expect(formatScore(-0.4)).toBe("0%");
    expect(formatScore(1.2)).toBe("100%");
  });
});

describe("formatSearchCost", () => {
  it("never renders $0.00, which reads as broken rather than as cheap", () => {
    expect(formatSearchCost(0.0000002)).toBe("<$0.01");
    expect(formatSearchCost(0)).toBe("$0");
    expect(formatSearchCost(1.5)).toBe("$1.50");
  });
});

describe("corpusSummary", () => {
  it("returns null for an empty corpus so the caller shows its empty state", () => {
    expect(corpusSummary([])).toBeNull();
    expect(corpusSummary(undefined)).toBeNull();
  });

  it("stays terse when everything indexed cleanly", () => {
    expect(corpusSummary([doc("indexed", "a"), doc("indexed", "b")])).toBe("2 documents");
  });

  it("calls out failures and partial indexing", () => {
    const summary = corpusSummary([doc("indexed", "a"), doc("failed", "b"), doc("processing", "c")]);
    expect(summary).toContain("3 documents");
    expect(summary).toContain("1 indexed");
    expect(summary).toContain("1 failed");
  });

  it("uses the singular for one document", () => {
    expect(corpusSummary([doc("indexed")])).toBe("1 document");
  });
});

describe("isSearchable", () => {
  it("requires at least one indexed document", () => {
    // Searching a corpus with nothing indexed spends an embedding call to
    // guarantee zero hits, so the playground disables itself instead.
    expect(isSearchable([doc("processing"), doc("failed")])).toBe(false);
    expect(isSearchable([doc("processing"), doc("indexed")])).toBe(true);
    expect(isSearchable([])).toBe(false);
  });
});

describe("formatBytes", () => {
  it("scales units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(MAX_UPLOAD_BYTES)).toBe("20.0 MB");
  });
});
