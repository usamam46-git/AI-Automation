"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { workflowsApi, type WorkflowVersion } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { flowToVersion, graphSignature, type BuilderGraph } from "@/lib/graph-mapping";
import { validateDraft } from "@/lib/graph-validation";

export type SaveState = "clean" | "unsaved" | "saving" | "saved" | "error";

/**
 * Debounced autosave for the builder canvas.
 *
 * `POST /workflows/{id}/versions` fully replaces the draft's node and edge rows,
 * so the complete set is always sent — there is no delta path to build. The
 * caller must NOT invalidate the builder query on success: the query cache holds
 * the live canvas, and a refetch would clobber edits made while the save was in
 * flight. The saved version's identity comes back on the response instead.
 *
 * `savedSignature` — the fingerprint of what the server currently holds — is
 * owned by the caller and lives in the query cache, NOT in this hook. That is
 * load-bearing. It used to be component state falling back to a cached value
 * that was never advanced after a save, so closing and reopening the builder
 * remounted the hook with an empty baseline while the cache entry survived
 * (staleTime: Infinity means no refetch). The graph then read as dirty and
 * autosaved an unchanged copy — which, on a published version, silently created
 * version N+1. The cache must stay the single source of the baseline.
 */
export function useWorkflowAutosave({
  workflowId,
  graph,
  versionId,
  savedSignature,
  enabled,
  onSaved,
}: {
  workflowId: string;
  graph: BuilderGraph;
  versionId: string | null;
  savedSignature: string | null;
  enabled: boolean;
  onSaved: (version: WorkflowVersion, signature: string) => void;
}) {
  const payload = React.useMemo(() => flowToVersion(graph), [graph]);
  const signature = React.useMemo(() => graphSignature(payload), [payload]);

  const isDirty = savedSignature !== null && signature !== savedSignature;

  const draftIssues = React.useMemo(() => validateDraft(graph), [graph]);
  const blocked = draftIssues.length > 0;

  const mutation = useMutation({
    mutationFn: (body: typeof payload) => workflowsApi.saveVersion(workflowId, body),
    onSuccess: (version, body) => onSaved(version, graphSignature(body)),
  });

  const save = mutation.mutate;
  const isEmptyNewGraph = versionId === null && graph.nodes.length === 0;

  React.useEffect(() => {
    if (!enabled || !isDirty || blocked) return;
    // Never conjure an empty version 1 just because the builder was opened.
    if (isEmptyNewGraph) return;

    const timer = setTimeout(() => save(payload), 800);
    return () => clearTimeout(timer);
  }, [blocked, enabled, isDirty, isEmptyNewGraph, payload, save]);

  const state: SaveState = mutation.isPending
    ? "saving"
    : mutation.isError
      ? "error"
      : isDirty
        ? "unsaved"
        : mutation.isSuccess
          ? "saved"
          : "clean";

  return {
    state,
    error: mutation.isError ? getApiErrorMessage(mutation.error, "Could not save") : null,
    /** Draft-integrity failures holding the save back — a save is skipped, not retried blindly. */
    blockingIssues: draftIssues,
    isDirty,
  };
}
