"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal, Plus } from "lucide-react";
import { ArchiveWorkspaceDialog } from "@/components/workspaces/archive-workspace-dialog";
import { WorkspaceDialog } from "@/components/workspaces/workspace-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { type Workspace, workspacesApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";

function WorkspaceSkeletonGrid() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, index) => (
        <Card key={index} className="p-4">
          <div className="flex items-start gap-3"><Skeleton className="size-10 rounded-2xl" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-48" /></div><Skeleton className="size-8" /></div>
        </Card>
      ))}
    </div>
  );
}

export default function WorkspacesPage() {
  const orgId = useAuthStore((state) => state.orgId);
  const currentWorkspaceId = useAppStore((state) => state.currentWorkspaceId);
  const setCurrentWorkspaceId = useAppStore((state) => state.setCurrentWorkspaceId);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editingWorkspace, setEditingWorkspace] = React.useState<Workspace | null>(null);
  const [archivingWorkspace, setArchivingWorkspace] = React.useState<Workspace | null>(null);

  const query = useQuery({ queryKey: ["workspaces", orgId], queryFn: workspacesApi.list, enabled: Boolean(orgId) });
  const workspaces = query.data ?? [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div><h2 className="text-xl font-semibold">Workspaces</h2><p className="text-sm text-muted-foreground">Manage active workspaces for this organization.</p></div>
        <Button onClick={() => setCreateOpen(true)}><Plus className="size-4" />New Workspace</Button>
      </div>

      {query.isLoading ? <WorkspaceSkeletonGrid /> : null}
      {query.isError ? <ErrorState message={getApiErrorMessage(query.error, "Could not load workspaces")} onRetry={() => query.refetch()} /> : null}
      {!query.isLoading && !query.isError && workspaces.length === 0 ? <EmptyState title="No workspaces yet" message="Create the first workspace for this organization." actionLabel="New Workspace" onAction={() => setCreateOpen(true)} /> : null}

      {!query.isLoading && !query.isError && workspaces.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {workspaces.map((workspace) => (
            <Card key={workspace.id} className="transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md hover:shadow-black/10">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <button type="button" onClick={() => setCurrentWorkspaceId(workspace.id)} className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary text-sm font-semibold text-primary-foreground">
                    {workspace.icon || workspace.name.charAt(0).toUpperCase()}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><h3 className="truncate text-sm font-semibold">{workspace.name}</h3>{workspace.is_default ? <Badge variant="soon">Default</Badge> : null}</div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">Created {new Date(workspace.created_at).toLocaleDateString()}</p>
                    {workspace.id === currentWorkspaceId ? <p className="mt-2 text-xs font-medium text-foreground">Current workspace</p> : null}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setCurrentWorkspaceId(workspace.id)}>Switch to workspace</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setEditingWorkspace(workspace)}>Rename</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setArchivingWorkspace(workspace)} className="text-destructive">Archive</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      <WorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
      <WorkspaceDialog open={Boolean(editingWorkspace)} onOpenChange={(open) => !open && setEditingWorkspace(null)} workspace={editingWorkspace} />
      <ArchiveWorkspaceDialog open={Boolean(archivingWorkspace)} onOpenChange={(open) => !open && setArchivingWorkspace(null)} workspace={archivingWorkspace} />
    </div>
  );
}
