"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal, Plus } from "lucide-react";
import { DeleteToolDialog } from "@/components/tools/delete-tool-dialog";
import { ToolDialog } from "@/components/tools/tool-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { type Tool, type ToolType, toolsApi, workspacesApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";

/**
 * The tool registry (Vol. 2 §3.3/§7.2, Vol. 4 §4.1). A tool registered here can
 * be referenced by `tool_id` from any node in the same workspace, which is the
 * only path that produces a `tool_executions` audit row — inline node config
 * has no registry row to point at, and `tool_executions.tool_id` is NOT NULL.
 *
 * Workspace-scoped like the Workflows list, and for the same reason: the
 * builder's registry picker is workspace-scoped (a tool's name is unique per
 * workspace, not per org), so browsing across workspaces here would show tools
 * that the workflow you're building cannot reference.
 */
const toolTypes: Array<ToolType | "all"> = ["all", "http_request", "erp_connector", "knowledge_search"];

const typeLabels: Record<string, string> = {
  all: "All",
  http_request: "HTTP",
  erp_connector: "ERP",
  knowledge_search: "Knowledge",
};

function ToolRowsSkeleton() {
  return (
    <Card className="overflow-hidden">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="grid grid-cols-[1.6fr_0.7fr_0.7fr_0.8fr_2rem] items-center gap-3 border-b border-border p-3 last:border-b-0">
          <div className="space-y-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-56" /></div><Skeleton className="h-6 w-16" /><Skeleton className="h-6 w-20" /><Skeleton className="h-4 w-24" /><Skeleton className="size-8" />
        </div>
      ))}
    </Card>
  );
}

/** The one-line summary of what the tool actually calls, from its type-specific config. */
function toolTarget(tool: Tool) {
  const config = (tool.config ?? {}) as Record<string, unknown>;
  if (tool.tool_type === "http_request") {
    const method = typeof config.method === "string" ? config.method : "GET";
    const url = typeof config.url === "string" ? config.url : "";
    return url ? `${method} ${url}` : "";
  }
  return typeof config.action === "string" ? config.action : "";
}

export default function ToolsPage() {
  const orgId = useAuthStore((state) => state.orgId);
  const workspaceId = useAppStore((state) => state.currentWorkspaceId);
  const setWorkspaceId = useAppStore((state) => state.setCurrentWorkspaceId);
  const [toolType, setToolType] = React.useState<ToolType | "all">("all");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editingTool, setEditingTool] = React.useState<Tool | null>(null);
  const [deletingTool, setDeletingTool] = React.useState<Tool | null>(null);

  const workspacesQuery = useQuery({ queryKey: ["workspaces", orgId], queryFn: workspacesApi.list, enabled: Boolean(orgId) });
  const workspaces = workspacesQuery.data ?? [];
  const activeWorkspace = workspaces.find((workspace) => workspace.id === workspaceId) ?? workspaces[0] ?? null;

  React.useEffect(() => {
    if (!workspaceId && activeWorkspace) setWorkspaceId(activeWorkspace.id);
  }, [activeWorkspace, setWorkspaceId, workspaceId]);

  // Same key shape the builder uses for its own tools fetch, so opening the
  // builder after visiting this page is instant. The filter is part of the key
  // because the API applies it server-side.
  const toolsQuery = useQuery({
    queryKey: ["tools", orgId, activeWorkspace?.id ?? null, toolType],
    queryFn: () => toolsApi.list({ workspaceId: activeWorkspace?.id, toolType }),
    enabled: Boolean(orgId && activeWorkspace?.id),
  });
  const tools = toolsQuery.data ?? [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Tools</h2>
          <p className="text-sm text-muted-foreground">
            Reusable tool definitions for {activeWorkspace?.name ?? "the selected workspace"}. Nodes reference these instead of carrying their own config.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} disabled={!activeWorkspace}><Plus className="size-4" />New Tool</Button>
      </div>

      <div className="flex w-full gap-1 overflow-x-auto rounded-xl border border-border bg-muted/30 p-1 sm:w-fit">
        {toolTypes.map((item) => (
          <button
            key={item}
            onClick={() => setToolType(item)}
            className={cn("rounded-lg px-3 py-1.5 text-sm transition-colors", toolType === item ? "bg-background shadow-sm shadow-black/5" : "text-muted-foreground hover:text-foreground")}
          >
            {typeLabels[item]}
          </button>
        ))}
      </div>

      {workspacesQuery.isLoading || toolsQuery.isLoading ? <ToolRowsSkeleton /> : null}
      {workspacesQuery.isError ? <ErrorState message={getApiErrorMessage(workspacesQuery.error, "Could not load workspaces")} onRetry={() => workspacesQuery.refetch()} /> : null}
      {toolsQuery.isError ? <ErrorState message={getApiErrorMessage(toolsQuery.error, "Could not load tools")} onRetry={() => toolsQuery.refetch()} /> : null}
      {!workspacesQuery.isLoading && !workspacesQuery.isError && workspaces.length === 0 ? (
        <EmptyState title="No workspace available" message="Create a workspace before registering tools." actionLabel="Go to Workspaces" onAction={() => { window.location.href = "/workspaces"; }} />
      ) : null}
      {!toolsQuery.isLoading && !toolsQuery.isError && activeWorkspace && tools.length === 0 ? (
        <EmptyState
          title={toolType === "all" ? "No tools yet" : "No tools of this type"}
          message="Register a tool here and any node in this workspace can call it — with an execution record for every call."
          actionLabel="New Tool"
          onAction={() => setCreateOpen(true)}
        />
      ) : null}

      {!toolsQuery.isLoading && !toolsQuery.isError && tools.length > 0 ? (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-[1.6fr_0.7fr_0.7fr_0.8fr_2rem] gap-3 border-b border-border px-3 py-2 text-xs font-medium uppercase text-muted-foreground sm:grid">
            <span>Name</span><span>Type</span><span>Writes</span><span>Created</span><span />
          </div>
          {tools.map((tool) => (
            <div
              key={tool.id}
              role="button"
              tabIndex={0}
              onClick={() => setEditingTool(tool)}
              onKeyDown={(event) => event.key === "Enter" && setEditingTool(tool)}
              className="grid gap-2 border-b border-border p-3 text-sm transition-colors last:border-b-0 hover:bg-muted/40 sm:grid-cols-[1.6fr_0.7fr_0.7fr_0.8fr_2rem] sm:items-center sm:gap-3"
            >
              <div className="min-w-0">
                <div className="truncate font-mono font-medium">{tool.name}</div>
                <div className="truncate text-xs text-muted-foreground">{tool.description || toolTarget(tool)}</div>
              </div>
              <div><Badge variant="outline">{typeLabels[tool.tool_type] ?? tool.tool_type}</Badge></div>
              <div>{tool.is_mutating ? <Badge variant="mutating">Writes</Badge> : <span className="text-muted-foreground">—</span>}</div>
              <div className="text-muted-foreground">{new Date(tool.created_at).toLocaleDateString()}</div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" onClick={(event) => event.stopPropagation()}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setEditingTool(tool)}>Edit</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDeletingTool(tool)} className="text-destructive">Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </Card>
      ) : null}

      <ToolDialog tool={null} open={createOpen} onOpenChange={setCreateOpen} />
      <ToolDialog tool={editingTool} open={Boolean(editingTool)} onOpenChange={(open) => !open && setEditingTool(null)} />
      <DeleteToolDialog tool={deletingTool} open={Boolean(deletingTool)} onOpenChange={(open) => !open && setDeletingTool(null)} />
    </div>
  );
}
