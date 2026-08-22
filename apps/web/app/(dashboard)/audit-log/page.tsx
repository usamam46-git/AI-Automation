"use client";

import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Lock, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { AUDIT_GRID, AuditLogRow } from "@/components/audit-log/audit-log-row";
import { AUDIT_ACTIONS, auditActionMeta, nextAuditCursor } from "@/lib/audit-log";
import { auditApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";

const PAGE_SIZE = 50;

function statusFromError(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | undefined)?.response?.status;
}

function RowsSkeleton() {
  return (
    <Card className="overflow-hidden">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className={cn("grid gap-3 border-b border-border p-3 last:border-b-0 sm:items-center", AUDIT_GRID)}>
          <div className="space-y-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-4 w-32" />
        </div>
      ))}
    </Card>
  );
}

/**
 * The audit trail, at `/audit-log`.
 *
 * `GET /api/v1/audit-logs` has existed since 2026-08-09 and had no consumer
 * until this page — the same shape the integrations endpoints were in before
 * the Settings page.
 *
 * Two things about it are deliberate:
 *
 * - **There is no refresh poll.** Every other list in the product polls because
 *   a run's status changes underneath the reader. An audit row never changes —
 *   the database physically rejects UPDATE and DELETE — so the only thing a
 *   poll could surface is a *new* row, and a trail that reorders itself while
 *   an auditor is reading it is worse than one they refresh deliberately.
 * - **A 403 is a state, not an error.** `audit:read` is Owner/Admin only and is
 *   in `WILDCARD_READ_EXEMPT`, so Viewer's `"*:read"` does not reach it. The
 *   locked card is the same treatment `settings/openai-key-card.tsx` gives the
 *   Owner-only BYOK surface.
 */
export default function AuditLogPage() {
  const orgId = useAuthStore((state) => state.orgId);
  const userId = useAuthStore((state) => state.userId);
  const [action, setAction] = React.useState<string>("all");

  const query = useInfiniteQuery({
    queryKey: ["audit-logs", orgId, action],
    queryFn: ({ pageParam }) => auditApi.list({ action: action === "all" ? null : action, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => nextAuditCursor(lastPage, PAGE_SIZE),
    enabled: Boolean(orgId),
    // A 403 is the locked state below, and retrying it just delays rendering it.
    retry: (failureCount, error) => statusFromError(error) !== 403 && failureCount < 2,
  });

  const entries = React.useMemo(() => query.data?.pages.flat() ?? [], [query.data]);
  const forbidden = query.isError && statusFromError(query.error) === 403;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 pt-1">
      <PageHeader
        eyebrow="Govern"
        title="Audit log"
        description="Every material action in this organization, newest first."
        aside={
          !forbidden ? (
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue placeholder="All actions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actions</SelectItem>
                {AUDIT_ACTIONS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {auditActionMeta(item).label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null
        }
      />

      {forbidden ? (
        <Card className="flex min-h-64 flex-col items-center justify-center p-8 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-surface-2 text-muted-foreground">
            <Lock className="size-5" aria-hidden />
          </span>
          <h3 className="mt-4 text-base font-semibold tracking-tight">Owners and admins only</h3>
          <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
            Audit rows name the person who acted and the IP address they acted from, so reading them needs the{" "}
            <code className="font-mono text-xs">audit:read</code> permission. Ask an owner of this organization.
          </p>
        </Card>
      ) : null}

      {!forbidden ? (
        <>
          {/* The governance claim, stated where it is being demonstrated. Both
              halves of Vol. 2 §13 §700 are real: the row is written inside the
              same transaction as the action, and a Postgres trigger rejects
              UPDATE and DELETE independently of this application. */}
          <div className="flex items-start gap-2.5 rounded-xl bg-status-ok-soft p-3.5 text-xs text-status-ok">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              Append-only. Each row is written inside the same database transaction as the action it records, and Postgres
              rejects any attempt to update or delete one — including from this application. Nothing here can be edited after
              the fact.
            </p>
          </div>

          {query.isLoading ? <RowsSkeleton /> : null}

          {query.isError && !forbidden ? (
            <ErrorState message={getApiErrorMessage(query.error, "Could not load the audit log")} onRetry={() => query.refetch()} />
          ) : null}

          {!query.isLoading && !query.isError && entries.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center">
              <h3 className="text-sm font-semibold">{action === "all" ? "Nothing recorded yet" : "No events match this filter"}</h3>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {action === "all"
                  ? "Publishing a workflow, triggering a run, deciding an approval or storing a credential each write a row here."
                  : "Try a different action, or clear the filter."}
              </p>
              {action !== "all" ? (
                <Button variant="outline" className="mt-4" onClick={() => setAction("all")}>
                  Clear filter
                </Button>
              ) : null}
            </div>
          ) : null}

          {entries.length > 0 ? (
            <Card className="overflow-hidden">
              <div className={cn("hidden gap-3 border-b border-border px-3 py-2 text-xs font-medium uppercase text-muted-foreground sm:grid", AUDIT_GRID)}>
                <span className="pl-[1.375rem]">Action</span>
                <span>Actor</span>
                <span>Resource</span>
                <span>IP</span>
                <span>When</span>
              </div>
              {entries.map((entry) => (
                <AuditLogRow key={entry.id} entry={entry} currentUserId={userId} />
              ))}
            </Card>
          ) : null}

          {query.hasNextPage ? (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                {query.isFetchingNextPage ? "Loading…" : "Load older events"}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
