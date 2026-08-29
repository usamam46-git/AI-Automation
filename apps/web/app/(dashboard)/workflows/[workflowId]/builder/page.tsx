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
import { NodeDetailView } from "@/components/workflow-builder/ndv/node-detail-view";
import { RunDock } from "@/components/workflow-builder/run-dock";
import { RunOverlayProvider } from "@/components/workflow-builder/run-overlay-context";
import { groupIssuesByNode, IssueProvider } from "@/components/workflow-builder/issue-context";
import { useWorkflowAutosave } from "@/hooks/use-workflow-autosave";
import {
  executionsApi,
  knowledgeApi,
  toolsApi,
  workflowsApi,
  type ResumeDecision,
  type WorkflowVersion,
} from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { EMPTY_GRAPH, flowToVersion, graphSignature, versionToFlow, type BuilderGraph } from "@/lib/graph-mapping";
import { parseValidationDetail, validateGraph, type ToolRegistry } from "@/lib/graph-validation";
import { SAMPLE_PAYLOAD_KEY } from "@/lib/node-output-shape";
import { buildRunOverlay, isTerminal } from "@/lib/run-overlay";
import { useAuthStore } from "@/stores/auth-store";
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

/**
 * The sample payload an author described on the Start node.
 *
 * It is the only description of the trigger that exists anywhere — the backend
 * ignores the key — so it is what a Test step sends. A graph with no sample
 * sends `{}`, exactly as every pre-dialog Run-now did.
 */
function sampleTriggerPayload(graph: BuilderGraph): Record<string, unknown> {
  for (const node of graph.nodes) {
    if (node.data.nodeType !== "start") continue;
    const sample = (node.data.config ?? {})[SAMPLE_PAYLOAD_KEY];
    if (sample && typeof sample === "object" && !Array.isArray(sample)) return sample as Record<string, unknown>;
  }
  return {};
}

/** Mirrors the loaded canvas: a left-to-right chain, no palette column. */
function BuilderSkeleton() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-muted/20">
      <div className="flex items-center gap-4">
        {Array.from({ length: 3 }).map((_, index) => (
          <React.Fragment key={index}>
            {index > 0 ? <Skeleton className="h-px w-10" /> : null}
            <Skeleton className="h-14 w-52 rounded-xl" />
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

export default function WorkflowBuilderPage({ params }: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = use(params);
  const queryClient = useQueryClient();
  const orgId = useAuthStore((state) => state.orgId);
  const resetBuilder = useWorkflowBuilderStore((state) => state.reset);
  const serverIssue = useWorkflowBuilderStore((state) => state.serverIssue);
  const setServerIssue = useWorkflowBuilderStore((state) => state.setServerIssue);

  React.useEffect(() => resetBuilder, [resetBuilder, workflowId]);

  const workflowQuery = useQuery({
    queryKey: ["workflow", workflowId],
    queryFn: () => workflowsApi.get(workflowId),
  });

  // The workspace's registry tools, for the tool node's picker AND for the two
  // validation rules that need to resolve a `tool_id`. Same query key shape as
  // the Tools page so the two share a cache. It waits on the workflow because
  // the workspace id comes off that row — a tool's name is unique per workspace,
  // and a node can only reference tools in its own.
  const toolsQuery = useQuery({
    queryKey: ["tools", orgId, workflowQuery.data?.workspace_id ?? null, "all"],
    queryFn: () => toolsApi.list({ workspaceId: workflowQuery.data!.workspace_id }),
    enabled: Boolean(workflowQuery.data?.workspace_id),
  });

  // Same workspace scoping and the same key shape as the Knowledge page, so the
  // builder's retrieval picker shares that cache. A `knowledge_search` node can
  // only reference a KB in its own workspace.
  const knowledgeQuery = useQuery({
    queryKey: ["knowledge-bases", orgId, workflowQuery.data?.workspace_id ?? null],
    queryFn: () => knowledgeApi.list({ workspaceId: workflowQuery.data!.workspace_id }),
    enabled: Boolean(workflowQuery.data?.workspace_id),
  });

  // Deliberately `undefined` until the fetch resolves, never `[]`: an empty map
  // means "every tool_id on this graph is dead", which would flash a wrong
  // unknown_tool error on every registry-backed node while the list loads.
  const toolRegistry = React.useMemo<ToolRegistry | undefined>(
    () => (toolsQuery.data ? new Map(toolsQuery.data.map((tool) => [tool.id, tool.is_mutating])) : undefined),
    [toolsQuery.data],
  );

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

  /**
   * The run the canvas is currently showing. Not in the query cache — it is the
   * result of an action, and it must never touch the builder's own cache entry,
   * which IS the canvas.
   */
  const [activeRunId, setActiveRunId] = React.useState<string | null>(null);

  /**
   * The Test step.
   *
   * Runs `data.versionId` — the version on screen, draft included. The old
   * implementation called `triggerRun`, which is always pinned to the workflow's
   * `current_version_id`, so pressing "Test run" on a draft silently ran the
   * PUBLISHED graph instead and reported success.
   *
   * The sample payload comes from the Start node, which is the only description
   * of the trigger that exists anywhere.
   */
  const testRunMutation = useMutation({
    mutationFn: (options: { untilNodeKey?: string | null; allowMutating?: boolean } = {}) => {
      if (!data.versionId) throw new Error("Add a step before running.");
      return executionsApi.testRun(workflowId, data.versionId, {
        trigger_payload: sampleTriggerPayload(graph),
        until_node_key: options.untilNodeKey ?? null,
        allow_mutating: options.allowMutating ?? false,
      });
    },
    onSuccess: (run) => {
      setActiveRunId(run.id);
      queryClient.invalidateQueries({ queryKey: ["executions"] });
    },
    onError: (error) => toast.error(getApiErrorMessage(error, "Could not start a test run")),
  });

  // Poll while the run is live, then stop. Its own cache key — writing run state
  // into the builder key would corrupt the open canvas.
  const runQuery = useQuery({
    queryKey: ["builder-run", activeRunId],
    queryFn: () => executionsApi.status(activeRunId as string),
    enabled: activeRunId !== null,
    refetchInterval: (query) => (query.state.data && isTerminal(query.state.data.status) ? false : 1500),
  });

  const overlay = React.useMemo(
    () =>
      runQuery.data
        ? buildRunOverlay(runQuery.data, { nodes: graph.nodes, edges: graph.edges })
        : null,
    [graph.edges, graph.nodes, runQuery.data],
  );

  const resumeMutation = useMutation({
    mutationFn: (decision: ResumeDecision) =>
      executionsApi.resume(activeRunId as string, { decision }),
    onSuccess: () => runQuery.refetch(),
    onError: (error) => toast.error(getApiErrorMessage(error, "Could not resolve the approval")),
  });

  // Client-side mirror of the backend rules — instant, precise, and the primary
  // source of per-node errors. The server's 422 stays the authority and is
  // merged in on top.
  const issues = React.useMemo(() => {
    const clientIssues = validateGraph(graph, toolRegistry);
    return serverIssue ? [...clientIssues, serverIssue] : clientIssues;
  }, [graph, serverIssue, toolRegistry]);

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
    // Breaks out of <main>'s padding to run edge to edge. The offsets MUST track
    // the shell: the header is h-16 (4rem) and main is `px-4 pb-10 md:px-6` with
    // no top padding since the Atomie pass. Get these wrong and the canvas
    // either scrolls the page or leaves a band of paper under the minimap.
    <div className="-mx-4 -mb-10 flex h-[calc(100dvh-4rem)] flex-col md:-mx-6">
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
          onTestRun={() => testRunMutation.mutate({})}
          testRunPending={testRunMutation.isPending}
          canTestRun={data.versionId !== null}
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
              <RunOverlayProvider overlay={overlay}>
              <div className="relative flex h-full min-h-0">
                <BuilderCanvas graph={graph} setGraph={setGraph} />
                {/* The detail view is an overlay, not a column — it renders
                    nothing until a node is opened, so the canvas keeps the full
                    width while you are building rather than while you are not. */}
                <NodeDetailView
                  graph={graph}
                  setGraph={setGraph}
                  issuesByNode={issuesByNode}
                  tools={toolsQuery.data}
                  knowledgeBases={knowledgeQuery.data}
                  onTestStep={(untilNodeKey) => testRunMutation.mutate({ untilNodeKey })}
                  testStepPending={testRunMutation.isPending}
                />

                {overlay ? (
                  <RunDock
                    overlay={overlay}
                    graph={graph}
                    startedAt={runQuery.data?.started_at ?? null}
                    approvePending={resumeMutation.isPending}
                    onApprove={() => resumeMutation.mutate("approved")}
                    onReject={() => resumeMutation.mutate("rejected")}
                    onClose={() => setActiveRunId(null)}
                  />
                ) : null}
              </div>
              </RunOverlayProvider>
            </ReactFlowProvider>
          </IssueProvider>
        )}
      </div>
    </div>
  );
}
