/**
 * lib/run-status.ts — the single source of truth for how a run's status looks
 * and reads, plus the terminality predicate that stops polling.
 *
 * Pure module (no React, no network) so it stays vitest-covered.
 *
 * `isTerminalRunStatus` is deliberately the ONLY place terminality is decided.
 * Both the detail page's ~2.5s poll and the list page's conditional 10s poll
 * read it; if they ever disagree, one of them polls forever.
 */

import { CircleCheck, CircleDashed, CircleSlash, CircleX, LoaderCircle, TriangleAlert, type LucideIcon } from "lucide-react";
import type { WorkflowRunStatus } from "@/lib/api";

export type RunStatusMeta = {
  label: string;
  /** Badge variant name — must exist in components/ui/badge.tsx's cva. */
  variant: WorkflowRunStatus;
  icon: LucideIcon;
  /** True once the backend will never move this run again. */
  terminal: boolean;
};

export const RUN_STATUS_META: Record<WorkflowRunStatus, RunStatusMeta> = {
  pending: { label: "Pending", variant: "pending", icon: CircleDashed, terminal: false },
  running: { label: "Running", variant: "running", icon: LoaderCircle, terminal: false },
  waiting_approval: { label: "Waiting", variant: "waiting_approval", icon: TriangleAlert, terminal: false },
  completed: { label: "Completed", variant: "completed", icon: CircleCheck, terminal: true },
  failed: { label: "Failed", variant: "failed", icon: CircleX, terminal: true },
  rejected: { label: "Rejected", variant: "rejected", icon: CircleSlash, terminal: true },
  cancelled: { label: "Cancelled", variant: "cancelled", icon: CircleSlash, terminal: true },
};

/** Unknown statuses are treated as non-terminal: keep polling rather than
 *  freeze the UI on a status a future backend added. */
export function isTerminalRunStatus(status: WorkflowRunStatus | string): boolean {
  return RUN_STATUS_META[status as WorkflowRunStatus]?.terminal ?? false;
}

export function runStatusMeta(status: WorkflowRunStatus | string): RunStatusMeta {
  return RUN_STATUS_META[status as WorkflowRunStatus] ?? { label: status, variant: "pending", icon: CircleDashed, terminal: false };
}

/** `1.2s` / `840ms` / `2m 4s`. Matches the §6.1 wireframe's `1.2s` form. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/** Elapsed ms between two ISO timestamps. `end` null means "still going" and
 *  measures against `now`, which is injectable so this stays pure. */
export function elapsedMs(startedAt: string | null, completedAt: string | null, now: number = Date.now()): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const end = completedAt ? Date.parse(completedAt) : now;
  if (Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/**
 * Costs are Numeric(12,6) server-side and a single agent node typically costs
 * fractions of a cent, so a plain 2dp currency format collapses the whole
 * timeline to `$0.00` / `$0.01`. Under a dollar we show 4 decimals — §6.1's
 * own example is `$0.014` — and 2 decimals once the figure is dollar-scale.
 *
 * Zero is a real, meaningful value (a tool or condition node that cost
 * nothing); null means "not applicable" and renders as an em dash.
 */
export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0.00";
  if (Math.abs(usd) < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(prompt: number | null, completion: number | null): string | null {
  if (prompt == null && completion == null) return null;
  return `${prompt ?? 0} in / ${completion ?? 0} out`;
}
