"use client";

import * as React from "react";
import { use } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import axios from "axios";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { BuilderCanvas } from "@/components/workflow-builder/builder-canvas";
import { BuilderToolbar } from "@/components/workflow-builder/builder-toolbar";
import { ConfigPanel } from "@/components/workflow-builder/config-panel";
import { groupIssuesByNode, IssueProvider } from "@/components/workflow-builder/issue-context";
import { useWorkflowAutosave } from "@/hooks/use-workflow-autosave";
import { executionsApi, workflowsApi, type WorkflowVersion } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { EMPTY_GRAPH, flowToVersion, graphSignature, versionToFlow, type BuilderGraph } from "@/lib/graph-mapping";
import { parseValidationDetail, validateGraph } from "@/lib/graph-validation";
import { useWorkflowBuilderStore } from "@/stores/workflow-builder-store";

/**
 * The builder's server state is one cache entry: the latest version's identity
 * plus its graph. Keeping the version id *inside* the entry rather than in the
 * query key matters — autosave can create version N+1, and a key that changed
 * on save would strand the canvas on an empty cache entry mid-edit.
 */
type BuilderData = {
  versionId: string | null;
  versionNumber: number | null;
  publishedAt: string | null;
  graph: BuilderGraph;
  /**
   * Fingerprint of the graph the server currently holds — autosave's baseline.
   * It lives here, in the cache, rather than in component state, and must be
   * advanced on every successful save. See use-workflow-autosave.ts for what
   * breaks when it goes stale.
   */
  savedSignature: string;
};

const EMPTY_BUILDER: BuilderData = {
  versionId: null,
  versionNumber: null,
  publishedAt: null,
  graph: EMPTY_GRAPH,
  savedSignature: graphSignature(flowToVersion(EMPTY_GRAPH)),
};

function BuilderSkeleton() {
  return (
    <div className="flex h-full min-h-0">
      <div className="hidden w-52 shrink-0 flex-col gap-1 border-r border-border bg-sidebar p-2 md:flex">
        {Array.from({ length: 7 }).map((_, index) => (
          <Skeleton key={index} className="h-8 w-full rounded-lg" />
        ))}
      </div>
      <div className="flex flex-1 items-center justify-center bg-muted/20">
        <div className="flex flex-col items-center gap-3">
          <Skeleton className="h-14 w-48 rounded-xl" />
          <Skeleton className="h-6 w-px" />
          <Skeleton className="h-14 w-48 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

export default function WorkflowBuilderPage({ params }: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = use(params);
  const queryClient = useQueryClient();
  const resetBuilder = useWorkflowBuilderStore((state) => state.reset);
  const serverIssue = useWorkflowBuilderStore((state) => state.serverIssue);
  const setServerIssue = useWorkflowBuilderStore((state) => state.setServerIssue);

  React.useEffect(() => resetBuilder, [resetBuilder, workflowId]);

  const workflowQuery = useQuery({
    queryKey: ["workflow", workflowId],
    queryFn: () => workflowsApi.get(workflowId),
  });

  const builderKey = React.useMemo(() => ["workflow-builder", workflowId], [workflowId]);

  const builderQuery = useQuery<BuilderData>({
    queryKey: builderKey,
    queryFn: async () => {
      const versions = await workflowsApi.listVersions(workflowId);
      // Highest version_number is the one the builder edits, published or not.
      const latest = versions.reduce<(typeof versions)[number] | null>(
        (best, version) => (best === null || version.version_number > best.version_number ? version : best),
        null,
      );
      if (!latest) return EMPTY_BUILDER;
      const version = await workflowsApi.getVersion(workflowId, latest.id);
      const graph = versionToFlow(version);
      return {
        versionId: version.id,
        versionNumber: version.version_number,
        publishedAt: version.published_at,
        graph,
        savedSignature: graphSignature(flowToVersion(graph)),
      };
    },
    // Load-bearing, do not remove: this cache entry IS the canvas state, and the
    // global QueryClient default (staleTime 20s) would let a background refetch
    // silently overwrite in-flight edits.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const data = builderQuery.data ?? EMPTY_BUILDER;
  const graph = data.graph;

  const setGraph = React.useCallback(
    (updater: (graph: BuilderGraph) => BuilderGraph) => {
      queryClient.setQueryData<BuilderData>(builderKey, (current) => {
        const base = current ?? EMPTY_BUILDER;
        return { ...base, graph: updater(base.graph) };
      });
      // The previous rejection described a graph that no longer exists.
      setServerIssue(null);
    },
    [builderKey, queryClient, setServerIssue],
  );

  const applySavedVersion = React.useCallback(
    (version: WorkflowVersion, signature?: string) => {
      queryClient.setQueryData<BuilderData>(builderKey, (current) => ({
        ...(current ?? EMPTY_BUILDER),
        versionId: version.id,
        versionNumber: version.version_number,
        publishedAt: version.published_at,
        // Only a save moves the baseline; a publish leaves the graph untouched.
        ...(signature === undefined ? {} : { savedSignature: signature }),
      }));
    },
    [builderKey, queryClient],
  );

  const autosave = useWorkflowAutosave({
    workflowId,
    graph,
    versionId: data.versionId,
    savedSignature: builderQuery.isSuccess ? data.savedSignature : null,
    enabled: builderQuery.isSuccess,
    onSaved: applySavedVersion,
  });

  const publishMutation = useMutation({
    mutationFn: () => workflowsApi.publishVersion(workflowId, data.versionId as string),
    onSuccess: (version) => {
      // The graph itself is unchanged by a publish, so autosave's baseline
      // stays valid — only the version's identity and published_at move.
      applySavedVersion(version);
      setServerIssue(null);
      // The shell's list and detail views show status/current_version_id.
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
      queryClient.invalidateQueries({ queryKey: ["workflow", workflowId] });
      toast.success(`Published version ${version.version_number}`);
    },
    onError: (error) => {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;

      if (status === 422) {
        const detail = axios.isAxiosError(error) ? error.response?.data?.detail : undefined;
        const knownKeys = new Set(graph.nodes.map((node) => node.id));
        const issue = parseValidationDetail(detail, knownKeys);
        setServerIssue(issue);
        toast.error(issue.nodeKeys.length > 0 ? "Publish rejected — see the highlighted nodes" : "Publish rejected");
        return;
      }

      if (status === 409) {
        // Someone published this version elsewhere; our copy is stale.
        toast.error("This version was already published. Reloading the latest.");
        builderQuery.refetch();
        return;
      }

      toast.error(getApiErrorMessage(error, "Could not publish"));
    },
  });

  const testRunMutation = useMutation({
    mutationFn: () => executionsApi.triggerRun(workflowId, { trigger_payload: {} }),
    onSuccess: (run) => {
      toast.success("Run started", {
        description: run.id,
        action: { label: "Copy ID", onClick: () => navigator.clipboard.writeText(run.id) },
      });
    },
    onError: (error) => toast.error(getApiErrorMessage(error, "Could not start a run")),
  });

  // Client-side mirror of the backend rules — instant, precise, and the primary
  // source of per-node errors. The server's 422 stays the authority and is
  // merged in on top.
  const issues = React.useMemo(() => {
    const clientIssues = validateGraph(graph);
    return serverIssue ? [...clientIssues, serverIssue] : clientIssues;
  }, [graph, serverIssue]);

  const issuesByNode = React.useMemo(() => groupIssuesByNode(issues), [issues]);
  const bannerIssues = React.useMemo(() => issues.filter((issue) => issue.nodeKeys.length === 0), [issues]);

  const isLoading = workflowQuery.isLoading || builderQuery.isLoading;
  const error =
    (workflowQuery.isError && {
      message: getApiErrorMessage(workflowQuery.error, "Could not load this workflow"),
      retry: () => workflowQuery.refetch(),
    }) ||
    (builderQuery.isError && {
      message: getApiErrorMessage(builderQuery.error, "Could not load the workflow graph"),
      retry: () => builderQuery.refetch(),
    }) ||
    null;

  return (
    <div className="-m-4 flex h-[calc(100dvh-3.5rem)] flex-col md:-m-5">
      {workflowQuery.data ? (
        <BuilderToolbar
          workflow={workflowQuery.data}
          versionNumber={data.versionNumber}
          publishedAt={data.publishedAt}
          saveState={autosave.state}
          saveError={autosave.error}
          bannerIssues={bannerIssues}
          // Only the draft-integrity rules hard-block publishing. Shape and
          // approval problems are shown inline but still go to the server, which
          // stays the authority on them — and a divergence between the two
          // validators must surface as a real 422, not be hidden by the button.
          publishBlockingCount={autosave.blockingIssues.length}
          onPublish={() => publishMutation.mutate()}
          publishPending={publishMutation.isPending}
          onTestRun={() => testRunMutation.mutate()}
          testRunPending={testRunMutation.isPending}
        />
      ) : null}

      <div className="relative min-h-0 flex-1">
        {error ? (
          <div className="flex h-full items-center justify-center p-6">
            <ErrorState message={error.message} onRetry={error.retry} />
          </div>
        ) : isLoading ? (
          <BuilderSkeleton />
        ) : (
          <IssueProvider issues={issuesByNode}>
            <ReactFlowProvider>
              <div className="flex h-full min-h-0">
                <BuilderCanvas graph={graph} setGraph={setGraph} />
                <ConfigPanel graph={graph} setGraph={setGraph} issuesByNode={issuesByNode} />
              </div>
            </ReactFlowProvider>
          </IssueProvider>
        )}
      </div>
    </div>
  );
}
