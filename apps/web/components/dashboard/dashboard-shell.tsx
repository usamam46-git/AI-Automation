"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, BookText, Bot, ChevronDown, LayoutDashboard, LayoutGrid, LogOut, Plus, Settings, Workflow, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkspaceDialog } from "@/components/workspaces/workspace-dialog";
import { ThemeToggle } from "@/components/dashboard/theme-toggle";
import { authApi, workspacesApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";

// activeNavItem below uses `find` on a startsWith match, so the FIRST matching
// entry wins. Every href here must be a distinct top-level segment — a nested
// route like /workflows/x/executions would be swallowed by /workflows.
const navItems = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Workflows", href: "/workflows", icon: Workflow },
  { label: "Executions", href: "/executions", icon: Activity },
  { label: "Tools", href: "/tools", icon: Wrench },
  { label: "Knowledge", href: "/knowledge", icon: BookText },
  { label: "Workspaces", href: "/workspaces", icon: LayoutGrid },
  { label: "Settings", href: "/settings", icon: Settings },
];

const soonItems = [
  { label: "Agents", icon: Bot },
];

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const orgId = useAuthStore((state) => state.orgId);
  const userId = useAuthStore((state) => state.userId);
  const clearAuth = useAuthStore((state) => state.clearAuth);
  const currentWorkspaceId = useAppStore((state) => state.currentWorkspaceId);
  const setCurrentWorkspaceId = useAppStore((state) => state.setCurrentWorkspaceId);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = React.useState(false);

  const workspacesQuery = useQuery({
    queryKey: ["workspaces", orgId],
    queryFn: workspacesApi.list,
    enabled: Boolean(orgId),
  });

  const workspaces = workspacesQuery.data ?? [];
  const currentWorkspace = workspaces.find((workspace) => workspace.id === currentWorkspaceId) ?? workspaces[0] ?? null;

  // Reconcile the (persisted) selection with what the org actually has. This
  // handles two cases with one line, and the second is why it is not just a
  // null check: a STORED id that no longer resolves — workspace archived, or a
  // different user on the same browser — would otherwise sit in the store while
  // the header displayed `workspaces[0]`, so every list filtered by an id the
  // API never matches and the whole app looked empty. Nothing runs while the
  // list is still loading, since `currentWorkspace` is null until it arrives.
  React.useEffect(() => {
    if (currentWorkspace && currentWorkspace.id !== currentWorkspaceId) setCurrentWorkspaceId(currentWorkspace.id);
  }, [currentWorkspace, currentWorkspaceId, setCurrentWorkspaceId]);

  const activeNavItem = navItems.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
  const title = activeNavItem?.label ?? "Workflows";

  async function logout() {
    try {
      await authApi.logout();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Logout failed"));
    } finally {
      clearAuth();
      // The workspace selection outlives the session now that it is persisted,
      // so clear it here too — the next account on this browser must not start
      // inside the previous one's workspace id.
      setCurrentWorkspaceId(null);
      queryClient.clear();
      router.replace("/login");
    }
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col">
        <div className="border-b border-sidebar-border p-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-auto w-full justify-between rounded-xl px-2 py-2">
                {workspacesQuery.isLoading ? (
                  <div className="flex w-full items-center gap-2"><Skeleton className="size-8 rounded-2xl" /><Skeleton className="h-8 flex-1" /></div>
                ) : (
                  <span className="flex min-w-0 items-center gap-2 text-left">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-2xl bg-primary text-sm font-semibold text-primary-foreground">{currentWorkspace?.icon || currentWorkspace?.name?.charAt(0)?.toUpperCase() || "A"}</span>
                    <span className="min-w-0"><span className="block truncate text-sm font-medium">{currentWorkspace?.name ?? "No workspace"}</span><span className="block truncate text-xs text-muted-foreground">Org {orgId?.slice(0, 8) ?? "session"}</span></span>
                  </span>
                )}
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-60" align="start">
              <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
              {workspaces.map((workspace) => (
                <DropdownMenuItem key={workspace.id} onSelect={() => setCurrentWorkspaceId(workspace.id)}>
                  <span className="flex size-6 items-center justify-center rounded-lg bg-muted text-xs font-medium">{workspace.icon || workspace.name.charAt(0).toUpperCase()}</span>
                  <span className="flex-1 truncate">{workspace.name}</span>
                  {workspace.is_default ? <Badge variant="soon">Default</Badge> : null}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setWorkspaceDialogOpen(true)}><Plus className="size-4" />Create workspace</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = item.href === activeNavItem?.href;
            return (
              <Link key={item.href} href={item.href} className={cn("flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent", active && "bg-sidebar-accent font-medium")}>
                <Icon className="size-4" />{item.label}
              </Link>
            );
          })}
          <div className="mt-3 border-t border-sidebar-border pt-3">
            {soonItems.map((item) => { const Icon = item.icon; return <div key={item.label} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground"><Icon className="size-4" />{item.label}<Badge variant="soon" className="ml-auto">Soon</Badge></div>; })}
          </div>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-border px-4">
          <div><h1 className="text-xl font-semibold">{title}</h1><p className="text-xs text-muted-foreground">{currentWorkspace?.name ?? "Workspace session"}</p></div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="rounded-full"><span className="flex size-7 items-center justify-center rounded-full bg-muted text-xs font-semibold">{userId?.slice(0, 1).toUpperCase() ?? "U"}</span></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel><span className="block">Profile</span><span className="block truncate text-xs font-normal text-muted-foreground">{userId ?? "Current user"}</span></DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={logout}><LogOut className="size-4" />Logout</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-4 md:p-5">{children}</main>
      </div>
      <WorkspaceDialog open={workspaceDialogOpen} onOpenChange={setWorkspaceDialogOpen} />
    </div>
  );
}
