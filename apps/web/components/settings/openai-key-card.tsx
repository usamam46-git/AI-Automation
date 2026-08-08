"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, EyeOff, KeyRound, Loader2, Lock, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { integrationsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { useAuthStore } from "@/stores/auth-store";

const QUERY_KEY = ["integration", "openai_api_key"] as const;

function statusFromError(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | undefined)?.response?.status;
}

export function OpenAiKeyCard() {
  const orgId = useAuthStore((state) => state.orgId);
  const queryClient = useQueryClient();
  const [draftKey, setDraftKey] = React.useState("");
  const [revealed, setRevealed] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);

  const query = useQuery({
    queryKey: [...QUERY_KEY, orgId],
    queryFn: () => integrationsApi.get(),
    enabled: Boolean(orgId),
    // A 404 is the empty state ("no key stored"), not a failure, and a 403 is a
    // permanent answer for a non-Owner. Retrying either just delays the render.
    retry: (failureCount, error) => {
      const status = statusFromError(error);
      if (status === 404 || status === 403) return false;
      return failureCount < 1;
    },
  });

  const errorStatus = query.isError ? statusFromError(query.error) : undefined;
  const forbidden = errorStatus === 403;
  const stored = query.data ?? null;
  // 404 is "nothing stored yet" — distinct from a real load failure.
  const missing = errorStatus === 404;

  const saveMutation = useMutation({
    mutationFn: (key: string) => integrationsApi.set(key),
    onSuccess: (data) => {
      queryClient.setQueryData([...QUERY_KEY, orgId], data);
      setDraftKey("");
      setRevealed(false);
      toast.success("OpenAI key saved");
    },
    onError: (error) => toast.error(getApiErrorMessage(error, "Could not save the key")),
  });

  const removeMutation = useMutation({
    mutationFn: () => integrationsApi.remove(),
    onSuccess: () => {
      queryClient.setQueryData([...QUERY_KEY, orgId], undefined);
      void queryClient.invalidateQueries({ queryKey: [...QUERY_KEY, orgId] });
      setConfirmRemove(false);
      toast.success("OpenAI key removed. Runs fall back to the platform key.");
    },
    onError: (error) => toast.error(getApiErrorMessage(error, "Could not remove the key")),
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = draftKey.trim();
    if (!trimmed) return;
    saveMutation.mutate(trimmed);
  }

  if (query.isLoading) {
    return (
      <Card>
        <CardHeader><Skeleton className="h-5 w-40" /><Skeleton className="mt-2 h-4 w-72" /></CardHeader>
        <CardContent className="space-y-3"><Skeleton className="h-4 w-24" /><Skeleton className="h-9 w-full" /></CardContent>
      </Card>
    );
  }

  // integration:read / integration:write are Owner-only, deliberately — a stored
  // key is a direct billing-exposure lever. Render that as an explained state,
  // not as an error the user could retry their way out of.
  if (forbidden) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Lock className="size-4" />OpenAI API key</CardTitle>
          <CardDescription>Only an organization Owner can view or change billing credentials.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (query.isError && !missing) {
    return <ErrorState message={getApiErrorMessage(query.error, "Could not load the OpenAI key status")} onRetry={() => query.refetch()} />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4" />OpenAI API key</CardTitle>
        <CardDescription>
          Bring your own key. Stored encrypted with AES-256-GCM and never shown again after saving. With no key set, runs fall back to the platform key.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {stored ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <Check className="size-4 shrink-0 text-foreground" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">sk-{"•".repeat(12)}{stored.last_four}</p>
                <p className="truncate text-xs text-muted-foreground">Updated {new Date(stored.updated_at).toLocaleString()}</p>
              </div>
            </div>
            <Button variant="ghost" size="icon" className="text-destructive" onClick={() => setConfirmRemove(true)} aria-label="Remove key">
              <Trash2 className="size-4" />
            </Button>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
            No key stored for this organization.
          </p>
        )}

        <form onSubmit={submit} className="space-y-2">
          <Label htmlFor="openai-key">{stored ? "Replace key" : "Add key"}</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                id="openai-key"
                type={revealed ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-..."
                value={draftKey}
                onChange={(event) => setDraftKey(event.target.value)}
                className="pr-9"
              />
              <button
                type="button"
                onClick={() => setRevealed((value) => !value)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                aria-label={revealed ? "Hide key" : "Show key"}
              >
                {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            <Button type="submit" disabled={!draftKey.trim() || saveMutation.isPending}>
              {saveMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {stored ? "Replace" : "Save"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Checked for the <code className="font-mono">sk-</code> prefix only — the key is not verified against OpenAI until a workflow runs.
          </p>
        </form>
      </CardContent>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the OpenAI key?</AlertDialogTitle>
            <AlertDialogDescription>
              Agent nodes will fall back to the platform key on the next run. Runs already in flight are unaffected — the key is resolved once when a run starts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                removeMutation.mutate();
              }}
              disabled={removeMutation.isPending}
            >
              {removeMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
