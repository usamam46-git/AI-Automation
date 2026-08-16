"use client";

import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { type KnowledgeDocument, knowledgeApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";

/**
 * Reads the chunks a document was split into.
 *
 * This is the screen that makes chunking legible: retrieval returns chunks, not
 * documents, so "why did it not find that clause" is nearly always answered
 * here — the clause is split across a boundary, or the document extracted to
 * nothing. Showing the token count per chunk matters for the same reason; it is
 * the unit the embedding was actually billed on.
 *
 * Offset-paginated rather than cursor-paginated, matching the endpoint: chunks
 * share a `created_at` (one insert transaction) so a timestamp cursor cannot
 * page them, and `chunk_index` is a real total order.
 */
export function ChunkInspector({ kbId, document }: { kbId: string; document: KnowledgeDocument }) {
  const query = useQuery({
    queryKey: ["kb-chunks", kbId, document.id],
    queryFn: () => knowledgeApi.listChunks(kbId, document.id, { limit: 100 }),
    enabled: document.status === "indexed",
  });

  if (document.status !== "indexed") {
    return (
      <Card className="p-6">
        <p className="text-sm font-medium">{document.file_name}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {document.status === "failed"
            ? document.error || "Ingestion failed."
            : "Chunks appear once the document finishes indexing."}
        </p>
      </Card>
    );
  }

  if (query.isError) {
    return <ErrorState message={getApiErrorMessage(query.error, "Could not load chunks")} onRetry={() => query.refetch()} />;
  }

  if (query.isLoading) {
    return (
      <Card className="space-y-3 p-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-20 w-full rounded-lg" />
        ))}
      </Card>
    );
  }

  const chunks = query.data ?? [];

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate text-sm font-medium">{document.file_name}</p>
        <p className="shrink-0 text-xs text-muted-foreground">
          {chunks.length} {chunks.length === 1 ? "chunk" : "chunks"}
        </p>
      </div>

      {chunks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This document indexed to no chunks. That normally means it had no extractable text.
        </p>
      ) : (
        <ScrollArea className="max-h-[28rem]">
          <div className="flex flex-col gap-2 pr-3">
            {chunks.map((chunk) => (
              <div key={chunk.id} className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <span className="font-mono text-[11px] text-muted-foreground">#{chunk.chunk_index}</span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">{chunk.token_count} tokens</span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{chunk.content}</p>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </Card>
  );
}
