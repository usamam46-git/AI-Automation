/**
 * lib/dashboard-stats.ts — presentation logic for the §5.1 home dashboard.
 *
 * Pure module (no React, no network) so it stays vitest-covered, same split as
 * lib/run-status.ts. The page component does layout; every decision about what
 * a number *means* lives here.
 */

import type { DashboardStats, Workflow, WorkflowRunSummary } from "@/lib/api";

/**
 * `97.4%`, or `—` when the rate is null.
 *
 * Null is a real, distinct state — it means nothing has finished in the window,
 * not that everything failed. Rendering it as `0%` would tell a brand-new org
 * that its automation is completely broken. Kept as its own function precisely
 * so that decision has one home.
 */
export function formatSuccessRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Month-to-date spend. Whole dollars once the figure is dollar-scale, because
 * the card is a headline number and `$842.10` reads better than `$842.0973`.
 *
 * Note this is intentionally NOT lib/run-status.ts's `formatCost`: that one
 * shows 4 decimals under a dollar, which is right for a single node's cost in
 * the timeline and wrong for a monthly total (`$0.0412` as a headline looks
 * like a rendering bug).
 *
 * The `$` and the thousands separator are hardcoded rather than delegated to
 * `toLocaleString(undefined, {style: "currency"})`. That formats against the
 * *browser's* locale, so the same USD figure renders as `USD 842.10` or
 * `842,10 $US` depending on who is looking — while `formatCost` two files over
 * hardcodes `$`, so the timeline and the dashboard would disagree on the same
 * page. Costs are USD server-side (LLMClient._MODEL_PRICING); this is a
 * dollar amount, not a localised one.
 *
 * Sub-cent months are the exception, added 2026-08-22 (shakedown finding H5). Two
 * decimals renders any non-zero figure below a cent as `$0.00`, so three runs
 * costing $0.0036 read as free while the per-run rows underneath correctly showed
 * `$0.0012`. Every development and demo month is sub-cent, which made the card
 * permanently and confidently wrong. Below a cent it therefore shows four
 * decimals. That does not contradict the paragraph above — `$0.0412` looking like
 * a rendering bug is an argument about the $0.01–$1 band, which still gets two
 * decimals. An exact zero stays `$0.00`: nothing has run, and that is worth
 * saying plainly.
 */
export const SUB_CENT_THRESHOLD = 0.01;

export function formatMonthlyCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  const magnitude = Math.abs(usd);
  const decimals = magnitude > 0 && magnitude < SUB_CENT_THRESHOLD ? 4 : 2;
  const [whole, fraction] = magnitude.toFixed(decimals).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${usd < 0 ? "-" : ""}$${grouped}.${fraction}`;
}

/** `August 2026` — the cost card's subtitle, derived from the API's own boundary. */
export function formatCostPeriod(isoStart: string | null | undefined): string {
  if (!isoStart) return "This month";
  const date = new Date(isoStart);
  if (Number.isNaN(date.getTime())) return "This month";
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * The success-rate card's subtitle.
 *
 * A percentage built from three runs is not the same claim as one built from
 * three thousand, and the card has no room for a confidence interval — so the
 * sample size is stated outright rather than implied.
 */
export function successRateCaption(stats: Pick<DashboardStats, "success_rate_window_days" | "success_rate_sample_size">): string {
  if (stats.success_rate_sample_size === 0) return `No runs finished in ${stats.success_rate_window_days} days`;
  const runs = stats.success_rate_sample_size === 1 ? "run" : "runs";
  return `${stats.success_rate_sample_size} ${runs} · last ${stats.success_rate_window_days} days`;
}

/**
 * `2 min ago` / `14 min ago` / `3 hr ago` / `2 days ago`, matching the §5.1
 * wireframe's phrasing. `now` is injectable to keep this pure.
 *
 * Falls back to an em dash rather than "Invalid Date" — a run that has not
 * started yet legitimately has a null timestamp.
 */
export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";

  const seconds = Math.round((now - then) / 1000);
  if (seconds < 0) return "just now"; // clock skew between server and browser
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;

  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

/** Time-of-day greeting for the §5.1 header. `hour` is injectable for tests. */
export function greeting(hour: number = new Date().getHours()): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * The dashboard shows a *sample*, not the full lists — §5.1's wireframe has
 * four run rows and four workflow tiles, with a "View all" link for the rest.
 * Both endpoints are called without a limit so the result shares a React Query
 * cache entry with the full list pages; the trim happens here.
 */
export const RECENT_RUNS_SHOWN = 5;
export const WORKFLOW_TILES_SHOWN = 8;

export function recentRuns(runs: WorkflowRunSummary[] | undefined): WorkflowRunSummary[] {
  return (runs ?? []).slice(0, RECENT_RUNS_SHOWN);
}

/**
 * Tiles for "Your Workflows", newest first.
 *
 * Archived workflows are dropped: the dashboard is a working surface, and an
 * archived workflow is by definition not something you act on today. Drafts
 * stay — a half-built workflow is exactly the thing you came back to finish.
 */
export function workflowTiles(workflows: Workflow[] | undefined): Workflow[] {
  return (workflows ?? []).filter((workflow) => workflow.status !== "archived").slice(0, WORKFLOW_TILES_SHOWN);
}
