"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { ChunkInspector } from "@/components/knowledge/chunk-inspector";
import { DocumentDropzone } from "@/components/knowledge/document-dropzone";
import { DocumentList, DocumentListSkeleton } from "@/components/knowledge/document-list";
import { RetrievalPlayground } from "@/components/knowledge/retrieval-playground";
import { ErrorState } from "@/components/shared/error-state";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { knowledgeApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { corpusSummary, hasPendingDocuments, isSearchable } from "@/lib/knowledge";

/**
 * One knowledge base: upload, document list, chunk inspector, playground.
 *
 * **Document status is polled, not pushed** — same decision as the Executions
 * viewer, and for the same reason: there is no WebSocket infrastructure in this
 * product. The interval stops the moment nothing is `uploaded`/`processing`, so
 * a settled corpus makes no background requests at all.
 *
 * `useParams()` rather than a `params` prop: this is a client component, and
 * Next 16's async-params change applies to server components only.
 */
export default function KnowledgeBaseDetailPage() {
  const params = useParams<{ kbId: string }>();
  const kbId = params.kbId;
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const kbQuery = useQuery({
    queryKey: ["knowledge-base", kbId],
    queryFn: () => knowledgeApi.get(kbId),
    enabled: Boolean(kbId),
  });

  const documentsQuery = useQuery({
    queryKey: ["kb-documents", kbId],
    queryFn: () => knowledgeApi.listDocuments(kbId),
    enabled: Boolean(kbId),
    // Poll only while the worker could still change something.
    refetchInterval: (query) => (hasPendingDocuments(query.state.data) ? 2500 : false),
  });

  const documents = documentsQuery.data ?? [];

  // The selection is held as an ID and the row is DERIVED from the live list,
  // rather than storing the document object and syncing it in an effect. The
  // document mutates under the selection as ingestion progresses and can be
  // deleted outright, so a stored copy goes stale; deriving makes both cases
  // correct for free and keeps the inspector off a snapshot.
  const selected = documents.find((doc) => doc.id === selectedId) ?? null;

  if (kbQuery.isError) {
    return <ErrorState message={getApiErrorMessage(kbQuery.error, "Could not load this knowledge base")} onRetry={() => kbQuery.refetch()} />;
  }

  const kb = kbQuery.data;
  const summary = corpusSummary(documents);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href="/knowledge"
          className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Knowledge
        </Link>
        {kb ? (
          <>
            <h1 className="text-xl font-semibold tracking-tight">{kb.name}</h1>
            <p className="text-sm text-muted-foreground">
              {summary ? `${summary} · ` : ""}
              <span className="font-mono text-xs">{kb.embedding_model}</span>
            </p>
          </>
        ) : (
          <div className="space-y-2 py-1">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-4 w-72" />
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <DocumentDropzone kbId={kbId} />

          {documentsQuery.isError ? (
            <ErrorState
              message={getApiErrorMessage(documentsQuery.error, "Could not load documents")}
              onRetry={() => documentsQuery.refetch()}
            />
          ) : documentsQuery.isLoading ? (
            <DocumentListSkeleton />
          ) : documents.length === 0 ? (
            <Card className="p-6 text-center">
              <p className="text-sm font-medium">No documents yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Add a policy or contract above. Indexing usually takes a few seconds.
              </p>
            </Card>
          ) : (
            <DocumentList kbId={kbId} documents={documents} selectedId={selectedId} onSelect={(doc) => setSelectedId(doc.id)} />
          )}
        </div>

        <div className="flex flex-col gap-4">
          <RetrievalPlayground kbId={kbId} disabled={!isSearchable(documents)} />
          {selected ? <ChunkInspector kbId={kbId} document={selected} /> : null}
        </div>
      </div>
    </div>
  );
}
