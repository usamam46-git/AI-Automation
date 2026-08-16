"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, MoreHorizontal, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import AITextLoading from "@/components/ui/ai-text-loading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { type KnowledgeDocument, knowledgeApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { INGESTION_CAPTIONS, documentStatusLabel, documentStatusTone } from "@/lib/knowledge";
import { cn } from "@/lib/utils";

const TONE_CLASSES: Record<string, string> = {
  success: "border-transparent bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  danger: "border-transparent bg-red-500/10 text-red-600 dark:text-red-400",
  active: "border-transparent bg-blue-500/10 text-blue-600 dark:text-blue-400",
  pending: "border-transparent bg-muted text-muted-foreground",
};

function StatusBadge({ document }: { document: KnowledgeDocument }) {
  const tone = documentStatusTone(document.status);
  return (
    <Badge className={cn("gap-1.5 rounded-lg font-medium", TONE_CLASSES[tone])}>
      {document.status === "processing" ? <Loader2 className="size-3 animate-spin" /> : null}
      {document.status === "failed" ? <TriangleAlert className="size-3" /> : null}
      {documentStatusLabel(document.status)}
    </Badge>
  );
}

export function DocumentListSkeleton() {
  return (
    <Card className="overflow-hidden p-0">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 border-b border-border p-3 last:border-b-0">
          <Skeleton className="size-9 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-52" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-6 w-20 rounded-lg" />
        </div>
      ))}
    </Card>
  );
}

export function DocumentList({
  kbId,
  documents,
  selectedId,
  onSelect,
}: {
  kbId: string;
  documents: KnowledgeDocument[];
  selectedId: string | null;
  onSelect: (document: KnowledgeDocument) => void;
}) {
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = React.useState<KnowledgeDocument | null>(null);

  const remove = useMutation({
    mutationFn: (documentId: string) => knowledgeApi.removeDocument(kbId, documentId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["kb-documents", kbId] });
      toast.success("Document deleted");
      setPendingDelete(null);
    },
    onError: (error) => toast.error(getApiErrorMessage(error, "Could not delete document")),
  });

  // One shared ticker for every in-flight row, so ten processing documents
  // don't run ten independent intervals drifting out of phase with each other.
  const anyProcessing = documents.some((doc) => doc.status === "processing");

  return (
    <>
      <Card className="overflow-hidden p-0">
        {documents.map((document) => {
          const selected = document.id === selectedId;
          return (
            <div
              key={document.id}
              className={cn(
                "flex items-center gap-3 border-b border-border p-3 text-left transition-colors last:border-b-0",
                selected ? "bg-muted/70" : "hover:bg-muted/40",
              )}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                onClick={() => onSelect(document)}
                aria-current={selected}
              >
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
                  <FileText className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{document.file_name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {document.status === "failed" && document.error
                      ? document.error
                      : [document.page_count ? `${document.page_count} pages` : null, document.mime_type]
                          .filter(Boolean)
                          .join(" · ")}
                  </span>
                </span>
              </button>

              <StatusBadge document={document} />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-8">
                    <MoreHorizontal className="size-4" />
                    <span className="sr-only">Document actions</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem className="text-destructive" onSelect={() => setPendingDelete(document)}>
                    <Trash2 className="size-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}

        {anyProcessing ? (
          <div className="border-t border-border bg-muted/20">
            <AITextLoading texts={INGESTION_CAPTIONS} interval={1800} className="text-sm" />
          </div>
        ) : null}
      </Card>

      <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.file_name} and every chunk indexed from it will be removed. Workflows that search this
              knowledge base will stop finding its content. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (pendingDelete) remove.mutate(pendingDelete.id);
              }}
            >
              {remove.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
