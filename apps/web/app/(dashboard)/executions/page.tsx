"use client";

import { Activity } from "lucide-react";
import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { FilterTabs } from "@/components/shared/filter-tabs";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorState } from "@/components/shared/error-state";
import { RunStatusBadge } from "@/components/executions/run-status-badge";
import { executionsApi, workflowsApi, type WorkflowRunStatus } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { elapsedMs, formatCost, formatDuration, isTerminalRunStatus } from "@/lib/run-status";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";

const GRID = "sm:grid-cols-[1.6fr_0.9fr_1fr_0.7fr_0.7fr]";

const statuses: Array<WorkflowRunStatus | "all"> = ["all", "running", "waiting_approval", "completed", "failed", "rejected"];

function RunRowsSkeleton() {
  return (
    <Card className="overflow-hidden">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className={cn("grid grid-cols-[1.6fr_0.9fr_1fr_0.7fr_0.7fr] items-center gap-3 border-b border-border p-3 last:border-b-0")}>
          <div className="space-y-2"><Skeleton className="h-4 w-44" /><Skeleton className="h-3 w-24" /></div><Skeleton className="h-6 w-24" /><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-12" /><Skeleton className="h-4 w-14" />
        </div>
      ))}
    </Card>
  );
}

export default function ExecutionsPage() {
  const router = useRouter();
  const orgId = useAuthStore((state) => state.orgId);
  const workspaceId = useAppStore((state) => state.currentWorkspaceId);
  const [workflowId, setWorkflowId] = React.useState<string>("all");
  const [status, setStatus] = React.useState<WorkflowRunStatus | "all">("all");

  // Only used to populate the workflow filter. Scoped to the active workspace
  // so the dropdown matches what the workflows page shows.
  const workflowsQuery = useQuery({
    queryKey: ["workflows", orgId, workspaceId ?? null, "all"],
    queryFn: () => workflowsApi.list({ workspaceId, status: "all" }),
    enabled: Boolean(orgId),
  });
  const workflows = workflowsQuery.data ?? [];

  const runsQuery = useQuery({
    queryKey: ["executions", orgId, workflowId, status],
    queryFn: () => executionsApi.list({ workflowId: workflowId === "all" ? null : workflowId, status }),
    enabled: Boolean(orgId),
    refetchOnWindowFocus: true,
    // Poll only while something on this page can still move. A flat interval on
    // a page of finished runs is pure waste; watching a list is also lower-stakes
    // than watching the one run you triggered, hence 10s here vs ~2.5s on detail.
    refetchInterval: (query) => (query.state.data?.some((run) => !isTerminalRunStatus(run.status)) ? 10_000 : false),
  });
  const runs = runsQuery.data ?? [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 pt-1">
      <PageHeader
        title="Executions"
        description="Every workflow run in this organization, newest first."
        aside={
          <Select value={workflowId} onValueChange={setWorkflowId}>
            <SelectTrigger className="w-full sm:w-64"><SelectValue placeholder="All workflows" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All workflows</SelectItem>
              {workflows.map((workflow) => <SelectItem key={workflow.id} value={workflow.id}>{workflow.name}</SelectItem>)}
            </SelectContent>
          </Select>
        }
      />

      <FilterTabs
        options={statuses}
        value={status}
        onChange={setStatus}
        label="Filter runs by status"
        renderLabel={(item) => (item === "waiting_approval" ? "Waiting" : item)}
      />

      {runsQuery.isLoading ? <RunRowsSkeleton /> : null}
      {runsQuery.isError ? <ErrorState message={getApiErrorMessage(runsQuery.error, "Could not load executions")} onRetry={() => runsQuery.refetch()} /> : null}
      {!runsQuery.isLoading && !runsQuery.isError && runs.length === 0 ? (
        <EmptyState
          icon={Activity}
          title={status === "all" && workflowId === "all" ? "No runs yet" : "No runs match this filter"}
          message={status === "all" && workflowId === "all" ? "Trigger a published workflow with Run now to watch it execute here." : "Try a different workflow or status."}
          actionLabel={status === "all" && workflowId === "all" ? "Go to Workflows" : "Clear filters"}
          onAction={() => { if (status === "all" && workflowId === "all") router.push("/workflows"); else { setStatus("all"); setWorkflowId("all"); } }}
        />
      ) : null}

      {!runsQuery.isLoading && !runsQuery.isError && runs.length > 0 ? (
        <Card className="overflow-hidden">
          <div className={cn("hidden gap-3 border-b border-border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground sm:grid", GRID)}><span>Workflow</span><span>Status</span><span>Started</span><span>Duration</span><span>Cost</span></div>
          {runs.map((run) => (
            <div
              key={run.id}
              role="button"
              tabIndex={0}
              onClick={() => router.push(`/executions/${run.id}`)}
              onKeyDown={(event) => event.key === "Enter" && router.push(`/executions/${run.id}`)}
              className={cn("grid cursor-pointer gap-2 border-b border-border p-4 text-sm transition-colors last:border-b-0 hover:bg-surface-2 sm:items-center sm:gap-3", GRID)}
            >
              <div className="min-w-0"><div className="truncate font-medium">{run.workflow_name}</div><div className="truncate font-mono text-xs text-muted-foreground">v{run.version_number} · {run.id.slice(0, 8)}</div></div>
              <div><RunStatusBadge status={run.status} /></div>
              <div className="text-muted-foreground">{run.started_at ? new Date(run.started_at).toLocaleString() : <span className="text-muted-foreground/60">Not started</span>}</div>
              <div className="text-muted-foreground">{formatDuration(elapsedMs(run.started_at, run.completed_at))}</div>
              <div className="tabular-nums text-muted-foreground">{formatCost(run.total_cost_usd)}</div>
            </div>
          ))}
        </Card>
      ) : null}
    </div>
  );
}
