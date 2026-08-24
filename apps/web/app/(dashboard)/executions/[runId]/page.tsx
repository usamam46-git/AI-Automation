"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { ApprovalActionBar } from "@/components/executions/approval-action-bar";
import { ExecutionTimeline } from "@/components/executions/execution-timeline";
import { JsonBlock } from "@/components/executions/json-block";
import { NodeDetailPanel } from "@/components/executions/node-detail-panel";
import { RunStatusBadge } from "@/components/executions/run-status-badge";
import { executionsApi, workflowsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { elapsedMs, formatCost, formatDuration, formatTokens, isTerminalRunStatus } from "@/lib/run-status";
import { buildTimeline, defaultSelectedNodeKey, totalTokens } from "@/lib/run-timeline";

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-8 w-72" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <Card className="p-3"><div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div></Card>
        <Card className="p-4"><div className="space-y-3"><Skeleton className="h-6 w-40" /><Skeleton className="h-20 w-full" /><Skeleton className="h-32 w-full" /></div></Card>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-col gap-0.5"><span className="text-xs text-muted-foreground">{label}</span><span className="text-sm tabular-nums">{value}</span></div>;
}

export default function ExecutionDetailPage() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId;
  const [pickedNodeKey, setPickedNodeKey] = React.useState<string | null>(null);

  const runQuery = useQuery({
    queryKey: ["execution", runId],
    queryFn: () => executionsApi.get(runId),
    enabled: Boolean(runId),
    // Live status without WebSocket infrastructure. Stops the moment the run
    // settles — isTerminalRunStatus is the single predicate deciding that, so
    // this and the list page can never disagree about when to stop.
    refetchInterval: (query) => (query.state.data && isTerminalRunStatus(query.state.data.status) ? false : 2500),
  });
  const run = runQuery.data;

  // The version supplies each node's TYPE (for its icon) and the nodes that
  // have not run yet — neither is available from node_executions, which stores
  // only node_key and only for nodes that actually executed.
  //
  // A distinct query key from the builder's ['workflow-graph', ...]: that entry
  // is the live editable canvas graph held at staleTime Infinity, and writing
  // to it from here would corrupt an open builder.
  const versionQuery = useQuery({
    queryKey: ["execution-version", run?.workflow_id, run?.workflow_version_id],
    queryFn: () => workflowsApi.getVersion(run!.workflow_id, run!.workflow_version_id),
    enabled: Boolean(run?.workflow_id && run?.workflow_version_id),
    staleTime: Infinity, // a published version is immutable
  });

  const rows = React.useMemo(() => (run ? buildTimeline(versionQuery.data?.nodes ?? [], run) : []), [run, versionQuery.data]);

  // The panel auto-follows the run until the user picks a node themselves.
  // Derived during render rather than synced by an effect, so a poll that moves
  // the run forward re-targets the panel in the same pass — no cascading render,
  // and no stale selection if the picked node vanishes from the timeline.
  const autoNodeKey = defaultSelectedNodeKey(rows);
  const selectedNodeKey = pickedNodeKey && rows.some((row) => row.nodeKey === pickedNodeKey) ? pickedNodeKey : autoNodeKey;

  if (runQuery.isLoading) return <div className="mx-auto max-w-6xl"><DetailSkeleton /></div>;
  if (runQuery.isError || !run) {
    return (
      <div className="mx-auto max-w-6xl">
        <ErrorState title="Could not load this run" message={getApiErrorMessage(runQuery.error, "The execution may not exist, or belongs to another organization.")} onRetry={() => runQuery.refetch()} />
      </div>
    );
  }

  const selectedRow = rows.find((row) => row.nodeKey === selectedNodeKey) ?? null;
  const tokens = totalTokens(run.node_executions);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 pt-1">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Link href="/executions" className="app-eyebrow transition-colors hover:text-foreground"><ArrowLeft className="mr-1 size-3" />Executions</Link>
          <h1 className="mt-1.5 truncate text-2xl font-semibold tracking-tight">
            <span className="font-mono text-lg text-muted-foreground">Run #{run.id.slice(0, 8)}</span> · {run.workflow_name} <span className="text-muted-foreground">v{run.version_number}</span>
          </h1>
        </div>
        <RunStatusBadge status={run.status} className="shrink-0" />
      </div>

      <Card className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4">
        <Stat label="Started" value={run.started_at ? new Date(run.started_at).toLocaleString() : "Not started"} />
        <Stat label="Duration" value={formatDuration(elapsedMs(run.started_at, run.completed_at))} />
        <Stat label="Total cost" value={formatCost(run.total_cost_usd)} />
        <Stat label="Tokens" value={tokens ? formatTokens(tokens.prompt, tokens.completion)! : "—"} />
      </Card>

      {run.error ? (
        <Card className="bg-status-bad-soft p-5">
          <h3 className="mb-2 text-sm font-semibold text-status-bad">Run error</h3>
          <JsonBlock value={run.error} />
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:items-start">
        <Card className="p-2">
          <h3 className="app-eyebrow px-2.5 py-2">Timeline</h3>
          {versionQuery.isLoading && rows.length === 0 ? (
            <div className="space-y-2 p-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : (
            <ExecutionTimeline rows={rows} selectedNodeKey={selectedNodeKey} onSelect={setPickedNodeKey} />
          )}
        </Card>

        <Card className="p-5"><NodeDetailPanel row={selectedRow} /></Card>
      </div>

      {run.status === "waiting_approval" ? <ApprovalActionBar run={run} /> : null}
    </div>
  );
}
