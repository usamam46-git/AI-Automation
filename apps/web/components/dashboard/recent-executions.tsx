"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { RunStatusBadge } from "@/components/executions/run-status-badge";
import { formatRelativeTime } from "@/lib/dashboard-stats";
import { formatCost } from "@/lib/run-status";
import { cn } from "@/lib/utils";
import type { WorkflowRunSummary } from "@/lib/api";

/**
 * §5.1's "Recent Executions" block.
 *
 * Rows mirror the executions list's interaction (click or Enter to open the
 * run) but carry fewer columns — this is a glance, not the table. Duration is
 * dropped and the timestamp is relative, matching the wireframe's "started 2
 * min ago" phrasing.
 *
 * `formatCost` (not `formatMonthlyCost`) because these are per-run figures, the
 * same scale the timeline renders — fractions of a cent need 4 decimals or they
 * all collapse to $0.00.
 */
export function RecentExecutions({ runs, loading }: { runs: WorkflowRunSummary[]; loading: boolean }) {
  const router = useRouter();

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Recent Executions</h2>
        <Link href="/executions" className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
          View all <ArrowRight className="size-3.5" />
        </Link>
      </div>

      <Card className="overflow-hidden">
        {loading ? (
          Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3 border-b border-border p-3 last:border-b-0">
              <Skeleton className="h-6 w-24" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-20" />
              </div>
              <Skeleton className="h-4 w-16" />
            </div>
          ))
        ) : runs.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No runs yet. Publish a workflow and hit <span className="font-medium text-foreground">Run now</span> to see it here.
          </div>
        ) : (
          runs.map((run) => (
            <div
              key={run.id}
              role="button"
              tabIndex={0}
              onClick={() => router.push(`/executions/${run.id}`)}
              onKeyDown={(event) => event.key === "Enter" && router.push(`/executions/${run.id}`)}
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border p-3 text-sm transition-colors last:border-b-0",
                "cursor-pointer hover:bg-muted/40"
              )}
            >
              <RunStatusBadge status={run.status} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate font-medium">{run.workflow_name}</span>
              <span className="tabular-nums text-xs text-muted-foreground">{formatCost(run.total_cost_usd)}</span>
              {/* started_at is null until the worker picks the run up, so a
                  freshly-queued run falls back to when it was created rather
                  than rendering an em dash next to a "Pending" badge. */}
              <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(run.started_at ?? run.created_at)}</span>
            </div>
          ))
        )}
      </Card>
    </section>
  );
}
