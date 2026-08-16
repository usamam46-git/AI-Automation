"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { BookText, FileSignature, Loader2, MoreHorizontal, Plus, ScrollText, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { KnowledgeBaseDialog } from "@/components/knowledge/kb-dialog";
import { ErrorState } from "@/components/shared/error-state";
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
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import DisplayCards from "@/components/ui/display-cards";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { type KnowledgeBase, knowledgeApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Knowledge bases (build plan days 8-9).
 *
 * Workspace-scoped, matching Workflows and Tools: a `knowledge_search` node can
 * only reference a KB in its own workspace, so listing across workspaces would
 * show corpora the workflow you are building cannot use.
 */
function ListSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }).map((_, index) => (
        <Card key={index} className="space-y-3 p-4">
          <Skeleton className="size-9 rounded-lg" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-40" />
        </Card>
      ))}
    </div>
  );
}

/**
 * The empty state uses the stacked-card primitive rather than an icon and a
 * sentence, because "knowledge base" is an abstract noun until you see what
 * goes in one. Naming the three real document kinds this product is built
 * around does more than any illustration would.
 */
function KnowledgeEmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <Card className="flex flex-col items-center gap-8 px-6 py-12">
      <div className="w-full max-w-lg pb-16 pt-2">
        <DisplayCards
          cards={[
            { icon: <ScrollText className="size-3.5" />, title: "AP policy", description: "Approval thresholds and terms", meta: "PDF" },
            { icon: <FileSignature className="size-3.5" />, title: "Vendor contract", description: "Agreed rates and payment terms", meta: "DOCX" },
            { icon: <BookText className="size-3.5" />, title: "Employee handbook", description: "Expense and travel rules", meta: "Markdown" },
          ]}
        />
      </div>

      <div className="flex max-w-md flex-col items-center gap-2 text-center">
        <h2 className="text-base font-medium tracking-tight">Ground your agents in your own documents</h2>
        <p className="text-sm text-muted-foreground">
          Upload the policies and contracts your team actually works from. Agents can then search them mid-workflow and
          cite the passage a decision came from.
        </p>
        <Button className="mt-2" onClick={onCreate}>
          <Plus className="size-4" />
          New knowledge base
        </Button>
      </div>
    </Card>
  );
}

export default function KnowledgePage() {
  const queryClient = useQueryClient();
  const orgId = useAuthStore((state) => state.orgId);
  const workspaceId = useAppStore((state) => state.currentWorkspaceId);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<KnowledgeBase | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<KnowledgeBase | null>(null);
  // 409 is a permanent explained state, not a transient failure: something still
  // searches this corpus and retrying cannot change that. Same treatment as the
  // tools registry's delete dialog, which is the rule this one mirrors.
  const [blockedReason, setBlockedReason] = React.useState<string | null>(null);

  const query = useQuery({
    queryKey: ["knowledge-bases", orgId, workspaceId ?? null],
    queryFn: () => knowledgeApi.list({ workspaceId }),
    enabled: Boolean(orgId),
  });

  const remove = useMutation({
    mutationFn: (kbId: string) => knowledgeApi.remove(kbId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["knowledge-bases", orgId] });
      toast.success("Knowledge base deleted");
      setPendingDelete(null);
    },
    onError: (error) => {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        setBlockedReason(getApiErrorMessage(error, "This knowledge base is still in use."));
        return;
      }
      toast.error(getApiErrorMessage(error, "Could not delete knowledge base"));
    },
  });

  const knowledgeBases = query.data ?? [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Knowledge</h1>
          <p className="text-sm text-muted-foreground">Documents your agents can search and cite.</p>
        </div>
        {knowledgeBases.length > 0 ? (
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="size-4" />
            New
          </Button>
        ) : null}
      </div>

      {query.isError ? (
        <ErrorState message={getApiErrorMessage(query.error, "Could not load knowledge bases")} onRetry={() => query.refetch()} />
      ) : query.isLoading ? (
        <ListSkeleton />
      ) : knowledgeBases.length === 0 ? (
        <KnowledgeEmptyState
          onCreate={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {knowledgeBases.map((kb) => (
            <Card key={kb.id} className="group relative flex flex-col gap-3 p-4 transition-colors hover:bg-muted/40">
              <div className="flex items-start justify-between gap-2">
                <span className="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
                  <BookText className="size-4" />
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="relative z-10 size-8">
                      <MoreHorizontal className="size-4" />
                      <span className="sr-only">Knowledge base actions</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => {
                        setEditing(kb);
                        setDialogOpen(true);
                      }}
                    >
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive" onSelect={() => setPendingDelete(kb)}>
                      <Trash2 className="size-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div>
                {/* Stretched link: the whole card is the target, but the menu
                    button sits above it on z-index so it stays clickable. */}
                <Link href={`/knowledge/${kb.id}`} className="text-sm font-medium after:absolute after:inset-0 after:content-['']">
                  {kb.name}
                </Link>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{kb.embedding_model}</p>
              </div>
            </Card>
          ))}
        </div>
      )}

      <KnowledgeBaseDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} />

      <AlertDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (open) return;
          setPendingDelete(null);
          setBlockedReason(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {blockedReason ? "This knowledge base is still in use" : `Delete “${pendingDelete?.name}”?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {blockedReason
                ? `${blockedReason} The corpus is resolved when a run reaches the node, so deleting it would turn a working workflow into a run-time failure.`
                : "Every document and indexed chunk in it is deleted permanently. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{blockedReason ? "Close" : "Cancel"}</AlertDialogCancel>
            {blockedReason ? null : (
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
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
