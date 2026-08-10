"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, CircleDollarSign, Gauge, TriangleAlert } from "lucide-react";
import { ErrorState } from "@/components/shared/error-state";
import { RecentExecutions } from "@/components/dashboard/recent-executions";
import { StatCard } from "@/components/dashboard/stat-card";
import { WorkflowTiles } from "@/components/dashboard/workflow-tiles";
import { WorkflowDialog } from "@/components/workflows/workflow-dialog";
import { analyticsApi, executionsApi, workflowsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import {
  formatCostPeriod,
  formatMonthlyCost,
  formatSuccessRate,
  greeting,
  recentRuns,
  successRateCaption,
  workflowTiles,
} from "@/lib/dashboard-stats";
import { isTerminalRunStatus } from "@/lib/run-status";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Vol. 3 §5.1 — the home dashboard.
 *
 * Three data sources, deliberately kept as three queries rather than one
 * aggregate endpoint:
 *   - `analytics.dashboard()` for the stat cards (org-wide, genuinely new data);
 *   - `executions.list()` and `workflows.list()` for the two sections below,
 *     which reuse the EXACT query keys the Executions and Workflows pages use.
 *     That shared cache is the point: navigating from here to either list
 *     renders instantly with no refetch, and a run triggered on the workflows
 *     page invalidates this page's list for free.
 *
 * The stat cards are org-wide while the workflow tiles are workspace-scoped.
 * That asymmetry is intentional and matches the wireframe's own header, which
 * shows an org AND a workspace switcher: "Cost (MTD)" is a billing figure and
 * billing is per-org, but "Your Workflows" is the set you're currently working
 * in. `success_rate` and `cost_mtd_usd` would need a workspace filter on the
 * backend to be scoped, and Vol. 3 §5.1 asks for neither.
 */
export default function DashboardPage() {
  const orgId = useAuthStore((state) => state.orgId);
  const workspaceId = useAppStore((state) => state.currentWorkspaceId);
  const [createOpen, setCreateOpen] = React.useState(false);

  const statsQuery = useQuery({
    queryKey: ["dashboard-stats", orgId],
    queryFn: analyticsApi.dashboard,
    enabled: Boolean(orgId),
    refetchOnWindowFocus: true,
  });

  // Same key shape as app/(dashboard)/executions/page.tsx with no filters, so
  // the two pages share one cache entry. Don't add a `limit` here — it would
  // fork the key and double the fetching. The trim is client-side in recentRuns.
  const runsQuery = useQuery({
    queryKey: ["executions", orgId, "all", "all"],
    queryFn: () => executionsApi.list({}),
    enabled: Boolean(orgId),
    refetchOnWindowFocus: true,
    // Mirrors the executions list: poll only while something can still move.
    refetchInterval: (query) => (query.state.data?.some((run) => !isTerminalRunStatus(run.status)) ? 10_000 : false),
  });

  // Same key as the executions page's workflow-filter query.
  const workflowsQuery = useQuery({
    queryKey: ["workflows", orgId, workspaceId ?? null, "all"],
    queryFn: () => workflowsApi.list({ workspaceId, status: "all" }),
    enabled: Boolean(orgId),
  });

  const stats = statsQuery.data;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">{greeting()} 👋</h1>
        <p className="text-sm text-muted-foreground">Here&apos;s what your automation has been doing.</p>
      </div>

      {statsQuery.isError ? (
        <ErrorState message={getApiErrorMessage(statsQuery.error, "Could not load dashboard stats")} onRetry={() => statsQuery.refetch()} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Active Runs"
            value={String(stats?.active_runs ?? 0)}
            caption="Pending or running now"
            icon={Activity}
            accent="info"
            href="/executions"
            loading={statsQuery.isLoading}
          />
          <StatCard
            label="Needs Approval"
            value={String(stats?.needs_approval ?? 0)}
            caption={stats?.needs_approval ? "Waiting on a decision" : "Nothing waiting on you"}
            icon={TriangleAlert}
            accent="warning"
            href="/executions"
            loading={statsQuery.isLoading}
          />
          <StatCard
            label="Cost (MTD)"
            value={formatMonthlyCost(stats?.cost_mtd_usd)}
            caption={formatCostPeriod(stats?.cost_period_start)}
            icon={CircleDollarSign}
            accent="neutral"
            loading={statsQuery.isLoading}
          />
          <StatCard
            label="Success Rate"
            value={formatSuccessRate(stats?.success_rate)}
            caption={stats ? successRateCaption(stats) : undefined}
            icon={Gauge}
            accent="success"
            loading={statsQuery.isLoading}
          />
        </div>
      )}

      {runsQuery.isError ? (
        <ErrorState message={getApiErrorMessage(runsQuery.error, "Could not load recent executions")} onRetry={() => runsQuery.refetch()} />
      ) : (
        <RecentExecutions runs={recentRuns(runsQuery.data)} loading={runsQuery.isLoading} />
      )}

      {workflowsQuery.isError ? (
        <ErrorState message={getApiErrorMessage(workflowsQuery.error, "Could not load workflows")} onRetry={() => workflowsQuery.refetch()} />
      ) : (
        <WorkflowTiles workflows={workflowTiles(workflowsQuery.data)} loading={workflowsQuery.isLoading} onCreate={() => setCreateOpen(true)} />
      )}

      <WorkflowDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
