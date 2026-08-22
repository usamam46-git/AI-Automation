"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, LogOut, Plus } from "lucide-react";
import {
  ActivityIcon,
  AgentsIcon,
  AuditIcon,
  DashboardIcon,
  KnowledgeIcon,
  SettingsIcon,
  ToolsIcon,
  WorkflowIcon,
  WorkspacesIcon,
} from "@/components/ui/animated-icons";
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
// Icons are the animated set in components/ui/animated-icons — same Lucide
// geometry, driven by the row's hover/focus so nothing moves on its own, and
// inert under prefers-reduced-motion. See that file's header for the rules.
//
// Grouped since the Atomie pass: eight flat rows read as one undifferentiated
// list, and the group labels say what each half of the product is for. The
// order within each group is unchanged.
const navGroups = [
  {
    label: "Automate",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: DashboardIcon },
      { label: "Workflows", href: "/workflows", icon: WorkflowIcon },
      { label: "Executions", href: "/executions", icon: ActivityIcon },
    ],
  },
  {
    label: "Build",
    items: [
      { label: "Tools", href: "/tools", icon: ToolsIcon },
      { label: "Knowledge", href: "/knowledge", icon: KnowledgeIcon },
      { label: "Workspaces", href: "/workspaces", icon: WorkspacesIcon },
    ],
  },
  {
    label: "Govern",
    items: [
      // Owner/Admin only (`audit:read`). Shown to everyone anyway: the page
      // renders its own locked state, and the JWT carries no role claim to gate
      // on here without a backend change.
      { label: "Audit log", href: "/audit-log", icon: AuditIcon },
      { label: "Settings", href: "/settings", icon: SettingsIcon },
    ],
  },
];

// Sits below a rule, apart from the working rows, because it is the only
// destination that is mostly about unbuilt work. It was a disabled `Soon` label
// until 2026-08-21; a nav row you cannot click carries the same visual weight
// as one you can and teaches the reader nothing, so it now leads to a page that
// says what an agent is here today and what the `agents` module will add.
const previewItems = [
  { label: "Agents", href: "/agents", icon: AgentsIcon },
];

const allNavItems = [...navGroups.flatMap((group) => group.items), ...previewItems];

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

  // Preview rows are searched too, or /agents would match nothing.
  const activeNavItem = allNavItems.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );

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
    // h-screen + overflow-hidden, NOT min-h-screen. `main` below is the scroll
    // container, and it can only be one if its ancestors have a FIXED height —
    // with min-h-screen the shell grows to fit the content, the document
    // scrolls instead, and the sidebar scrolls away with it. Reported on
    // /agents and /audit-log, which are the first pages tall enough to show it.
    <div className="relative flex h-screen overflow-hidden bg-background text-foreground">
      {/* Ambient lime bloom. Fixed and inert, behind everything — the sidebar
          and the cards paint their own surfaces over it, so it reads as light
          in the room rather than as a gradient on a panel. */}
      <div className="app-bloom" aria-hidden />

      <aside className="app-scroll relative z-10 hidden w-64 shrink-0 flex-col overflow-y-auto px-3 py-4 md:flex">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-2.5 rounded-2xl bg-card p-2.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
              {workspacesQuery.isLoading ? (
                <div className="flex w-full items-center gap-2.5"><Skeleton className="size-9 rounded-xl" /><Skeleton className="h-9 flex-1" /></div>
              ) : (
                <>
                  <span className="app-tile size-9 shrink-0 text-sm font-semibold">
                    {currentWorkspace?.icon || currentWorkspace?.name?.charAt(0)?.toUpperCase() || "A"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold leading-tight">{currentWorkspace?.name ?? "No workspace"}</span>
                    <span className="block truncate text-xs leading-tight text-muted-foreground">Org {orgId?.slice(0, 8) ?? "session"}</span>
                  </span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                </>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-60" align="start">
            <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
            {workspaces.map((workspace) => (
              <DropdownMenuItem key={workspace.id} onSelect={() => setCurrentWorkspaceId(workspace.id)}>
                <span className="app-tile size-6 text-xs font-medium">{workspace.icon || workspace.name.charAt(0).toUpperCase()}</span>
                <span className="flex-1 truncate">{workspace.name}</span>
                {workspace.is_default ? <Badge variant="brand">Default</Badge> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setWorkspaceDialogOpen(true)}><Plus className="size-4" />Create workspace</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <nav className="mt-5 flex flex-1 flex-col gap-5">
          {navGroups.map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <span className="app-eyebrow mb-1.5 px-2.5">{group.label}</span>
              {group.items.map((item) => (
                <NavLink key={item.href} item={item} active={item.href === activeNavItem?.href} />
              ))}
            </div>
          ))}
          <div className="mt-auto flex flex-col gap-0.5 border-t border-border pt-4">
            {previewItems.map((item) => (
              <NavLink key={item.href} item={item} active={item.href === activeNavItem?.href} badge="Preview" />
            ))}
          </div>
        </nav>
      </aside>

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        {/* The title used to live here AND on every page. It now lives only on
            the page, via components/shared/page-header.tsx — this bar carries
            the account context that is genuinely global. */}
        <header className="flex h-16 shrink-0 items-center justify-end gap-1 px-4 md:px-6">
          <span className="mr-auto truncate text-sm font-medium md:hidden">
            {activeNavItem?.label ?? "Orkest"}
          </span>
          <ThemeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="rounded-full">
                <span className="flex size-8 items-center justify-center rounded-full bg-card text-xs font-semibold">{userId?.slice(0, 1).toUpperCase() ?? "U"}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel><span className="block">Profile</span><span className="block truncate text-xs font-normal text-muted-foreground">{userId ?? "Current user"}</span></DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={logout}><LogOut className="size-4" />Logout</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <main className="app-scroll flex-1 overflow-y-auto px-4 pb-10 md:px-6">{children}</main>
      </div>
      <WorkspaceDialog open={workspaceDialogOpen} onOpenChange={setWorkspaceDialogOpen} />
    </div>
  );
}

/**
 * One sidebar row.
 *
 * Its own component purely so the hover state is local — lifting it into
 * `DashboardShell` would re-render the whole shell, including the workspace
 * query and the header, on every pointer move across the nav.
 *
 * Focus counts as hover so the animation is reachable by keyboard, and the
 * active row animates on mount-in as a small acknowledgement of arrival.
 *
 * The active state is the reference's lime pill, and it carries INK text — lime
 * sits at L .87, so its foreground is near-black in BOTH themes. This is the one
 * place the brand colour appears in the nav, which is what keeps it meaning
 * "you are here" rather than becoming decoration.
 */
function NavLink({
  item,
  active,
  badge,
}: {
  item: { label: string; href: string; icon: React.ComponentType<{ className?: string; active?: boolean }> };
  active: boolean;
  /** Trailing chip, for rows that lead somewhere partly unbuilt. */
  badge?: string;
}) {
  const [hovered, setHovered] = React.useState(false);
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      className={cn(
        "flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition-colors",
        active
          ? "bg-primary font-semibold text-primary-foreground"
          : "text-muted-foreground hover:bg-card hover:text-foreground",
      )}
    >
      <Icon className="size-4" active={hovered} />
      {item.label}
      {badge ? (
        <span className={cn("ml-auto rounded-md px-1.5 py-0.5 text-[10px] font-medium", active ? "bg-foreground/10" : "bg-surface-2 text-muted-foreground")}>
          {badge}
        </span>
      ) : null}
    </Link>
  );
}
