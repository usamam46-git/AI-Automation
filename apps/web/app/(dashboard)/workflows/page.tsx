"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal, Play, Plus } from "lucide-react";
import { ArchiveWorkflowDialog } from "@/components/workflows/archive-workflow-dialog";
import { WorkflowDetailDialog } from "@/components/workflows/workflow-detail-dialog";
import { WorkflowDialog } from "@/components/workflows/workflow-dialog";
import { RunWorkflowDialog } from "@/components/workflows/run-workflow-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { type Workflow, type WorkflowStatus, workflowsApi, workspacesApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";

const statuses: Array<WorkflowStatus | "all"> = ["all", "draft", "published", "archived"];

function WorkflowRowsSkeleton() {
  return (
    <Card className="overflow-hidden">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="grid grid-cols-[1.4fr_0.8fr_0.8fr_0.9fr_2rem] items-center gap-3 border-b border-border p-3 last:border-b-0">
          <div className="space-y-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-56" /></div><Skeleton className="h-6 w-20" /><Skeleton className="h-4 w-20" /><Skeleton className="h-4 w-24" /><Skeleton className="size-8" />
        </div>
      ))}
    </Card>
  );
}

export default function WorkflowsPage() {
  const orgId = useAuthStore((state) => state.orgId);
  const workspaceId = useAppStore((state) => state.currentWorkspaceId);
  const setWorkspaceId = useAppStore((state) => state.setCurrentWorkspaceId);
  const [status, setStatus] = React.useState<WorkflowStatus | "all">("all");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [selectedWorkflow, setSelectedWorkflow] = React.useState<Workflow | null>(null);
  const [archivingWorkflow, setArchivingWorkflow] = React.useState<Workflow | null>(null);
  const [runningWorkflow, setRunningWorkflow] = React.useState<Workflow | null>(null);

  const workspacesQuery = useQuery({ queryKey: ["workspaces", orgId], queryFn: workspacesApi.list, enabled: Boolean(orgId) });
  const workspaces = workspacesQuery.data ?? [];
  const activeWorkspace = workspaces.find((workspace) => workspace.id === workspaceId) ?? workspaces[0] ?? null;

  React.useEffect(() => {
    if (!workspaceId && activeWorkspace) setWorkspaceId(activeWorkspace.id);
  }, [activeWorkspace, setWorkspaceId, workspaceId]);

  const workflowsQuery = useQuery({
    queryKey: ["workflows", orgId, activeWorkspace?.id ?? null, status],
    queryFn: () => workflowsApi.list({ workspaceId: activeWorkspace?.id, status }),
    enabled: Boolean(orgId && activeWorkspace?.id),
  });
  const workflows = workflowsQuery.data ?? [];

  function workspaceName(workflow: Workflow) {
    return workspaces.find((workspace) => workspace.id === workflow.workspace_id)?.name;
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 className="text-xl font-semibold">Workflows</h2><p className="text-sm text-muted-foreground">Metadata-only workflow shells for {activeWorkspace?.name ?? "the selected workspace"}.</p></div>
        <Button onClick={() => setCreateOpen(true)} disabled={!activeWorkspace}><Plus className="size-4" />New Workflow</Button>
      </div>

      <div className="flex w-full gap-1 overflow-x-auto rounded-xl border border-border bg-muted/30 p-1 sm:w-fit">
        {statuses.map((item) => <button key={item} onClick={() => setStatus(item)} className={cn("rounded-lg px-3 py-1.5 text-sm capitalize transition-colors", status === item ? "bg-background shadow-sm shadow-black/5" : "text-muted-foreground hover:text-foreground")}>{item}</button>)}
      </div>

      {workspacesQuery.isLoading || workflowsQuery.isLoading ? <WorkflowRowsSkeleton /> : null}
      {workspacesQuery.isError ? <ErrorState message={getApiErrorMessage(workspacesQuery.error, "Could not load workspaces")} onRetry={() => workspacesQuery.refetch()} /> : null}
      {workflowsQuery.isError ? <ErrorState message={getApiErrorMessage(workflowsQuery.error, "Could not load workflows")} onRetry={() => workflowsQuery.refetch()} /> : null}
      {!workspacesQuery.isLoading && !workspacesQuery.isError && workspaces.length === 0 ? <EmptyState title="No workspace available" message="Create a workspace before adding workflows." actionLabel="Go to Workspaces" onAction={() => { window.location.href = "/workspaces"; }} /> : null}
      {!workflowsQuery.isLoading && !workflowsQuery.isError && activeWorkspace && workflows.length === 0 ? <EmptyState title="No workflows here" message="Create the first workflow shell for this workspace." actionLabel="New Workflow" onAction={() => setCreateOpen(true)} /> : null}

      {!workflowsQuery.isLoading && !workflowsQuery.isError && workflows.length > 0 ? (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-[1.4fr_0.8fr_0.8fr_0.9fr_2rem] gap-3 border-b border-border px-3 py-2 text-xs font-medium uppercase text-muted-foreground sm:grid"><span>Name</span><span>Status</span><span>Trigger</span><span>Created</span><span /></div>
          {workflows.map((workflow) => (
            <div key={workflow.id} role="button" tabIndex={0} onClick={() => setSelectedWorkflow(workflow)} onKeyDown={(event) => event.key === "Enter" && setSelectedWorkflow(workflow)} className="grid gap-2 border-b border-border p-3 text-sm transition-colors last:border-b-0 hover:bg-muted/40 sm:grid-cols-[1.4fr_0.8fr_0.8fr_0.9fr_2rem] sm:items-center sm:gap-3">
              <div className="min-w-0"><div className="truncate font-medium">{workflow.name}</div><div className="truncate text-xs text-muted-foreground">{workflow.description || workspaceName(workflow) || workflow.workspace_id}</div></div>
              <div><Badge variant={workflow.status}>{workflow.status}</Badge></div>
              <div className="capitalize text-muted-foreground">{workflow.trigger_type}</div>
              <div className="text-muted-foreground">{new Date(workflow.created_at).toLocaleDateString()}</div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" onClick={(event) => event.stopPropagation()}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setRunningWorkflow(workflow)} disabled={!workflow.current_version_id}><Play className="size-4" />Run now</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setSelectedWorkflow(workflow)}>View details</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setArchivingWorkflow(workflow)} className="text-destructive">Archive</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </Card>
      ) : null}

      <WorkflowDialog open={createOpen} onOpenChange={setCreateOpen} />
      <WorkflowDetailDialog workflow={selectedWorkflow} open={Boolean(selectedWorkflow)} onOpenChange={(open) => !open && setSelectedWorkflow(null)} workspaceName={selectedWorkflow ? workspaceName(selectedWorkflow) : undefined} onRun={setRunningWorkflow} />
      <RunWorkflowDialog workflow={runningWorkflow} open={Boolean(runningWorkflow)} onOpenChange={(open) => !open && setRunningWorkflow(null)} />
      <ArchiveWorkflowDialog workflow={archivingWorkflow} open={Boolean(archivingWorkflow)} onOpenChange={(open) => !open && setArchivingWorkflow(null)} />
    </div>
  );
}
