import { describe, expect, it } from "vitest";
import {
  RECENT_RUNS_SHOWN,
  WORKFLOW_TILES_SHOWN,
  formatCostPeriod,
  formatMonthlyCost,
  formatRelativeTime,
  formatSuccessRate,
  greeting,
  recentRuns,
  successRateCaption,
  workflowTiles,
} from "@/lib/dashboard-stats";
import type { Workflow, WorkflowRunSummary, WorkflowStatus } from "@/lib/api";

function workflow(id: string, status: WorkflowStatus): Workflow {
  return {
    id,
    organization_id: "org",
    workspace_id: "ws",
    name: `Workflow ${id}`,
    description: null,
    status,
    trigger_type: "manual",
    trigger_config: null,
    current_version_id: null,
    next_run_at: null,
    last_triggered_at: null,
    has_webhook_secret: false,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
}

function run(id: string): WorkflowRunSummary {
  return {
    id,
    workflow_id: "wf",
    workflow_name: "Invoice Processing",
    workflow_version_id: "v",
    version_number: 1,
    status: "completed",
    started_at: "2026-08-10T10:00:00Z",
    completed_at: "2026-08-10T10:00:02Z",
    total_cost_usd: 0.01,
    created_at: "2026-08-10T10:00:00Z",
  };
}

describe("formatSuccessRate", () => {
  it("renders a fraction as a one-decimal percentage", () => {
    expect(formatSuccessRate(0.974)).toBe("97.4%");
    expect(formatSuccessRate(1)).toBe("100.0%");
  });

  it("renders null as an em dash, NOT as 0%", () => {
    // The distinction is the whole reason the backend returns null: an org with
    // no finished runs has no success rate, and "0%" reads as total failure.
    expect(formatSuccessRate(null)).toBe("—");
    expect(formatSuccessRate(undefined)).toBe("—");
  });

  it("still renders a genuine zero as 0%", () => {
    expect(formatSuccessRate(0)).toBe("0.0%");
  });
});

describe("formatMonthlyCost", () => {
  it("shows two decimals for a monthly total", () => {
    expect(formatMonthlyCost(842.0973)).toBe("$842.10");
    expect(formatMonthlyCost(0)).toBe("$0.00");
  });

  it("groups thousands and hardcodes the dollar sign, independent of runtime locale", () => {
    // Not toLocaleString: that renders "USD 842.10" under some locales (the CI
    // runner's included) while lib/run-status.ts's formatCost hardcodes "$",
    // so the timeline and these cards would disagree on the same page.
    expect(formatMonthlyCost(1234567.891)).toBe("$1,234,567.89");
  });

  it("renders a missing figure as an em dash", () => {
    expect(formatMonthlyCost(null)).toBe("—");
  });
});

describe("formatCostPeriod", () => {
  it("names the month of the API's own boundary", () => {
    expect(formatCostPeriod("2026-08-01T00:00:00Z")).toBe("August 2026");
  });

  it("falls back rather than rendering an invalid date", () => {
    expect(formatCostPeriod(null)).toBe("This month");
    expect(formatCostPeriod("not-a-date")).toBe("This month");
  });
});

describe("successRateCaption", () => {
  it("states the sample size so a 100% from two runs is not oversold", () => {
    expect(successRateCaption({ success_rate_window_days: 30, success_rate_sample_size: 2 })).toBe("2 runs · last 30 days");
  });

  it("singularises one run", () => {
    expect(successRateCaption({ success_rate_window_days: 30, success_rate_sample_size: 1 })).toBe("1 run · last 30 days");
  });

  it("says so plainly when nothing finished", () => {
    expect(successRateCaption({ success_rate_window_days: 30, success_rate_sample_size: 0 })).toBe("No runs finished in 30 days");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-08-10T12:00:00Z");

  it("matches the §5.1 wireframe's phrasing", () => {
    expect(formatRelativeTime("2026-08-10T11:58:00Z", now)).toBe("2 min ago");
    expect(formatRelativeTime("2026-08-10T11:46:00Z", now)).toBe("14 min ago");
    expect(formatRelativeTime("2026-08-10T11:00:00Z", now)).toBe("1 hr ago");
  });

  it("steps up through days and months", () => {
    expect(formatRelativeTime("2026-08-09T12:00:00Z", now)).toBe("1 day ago");
    expect(formatRelativeTime("2026-08-05T12:00:00Z", now)).toBe("5 days ago");
    expect(formatRelativeTime("2026-06-10T12:00:00Z", now)).toBe("2 months ago");
  });

  it("collapses anything under a minute to 'just now'", () => {
    expect(formatRelativeTime("2026-08-10T11:59:30Z", now)).toBe("just now");
  });

  it("does not render a negative age when the browser clock lags the server", () => {
    expect(formatRelativeTime("2026-08-10T12:05:00Z", now)).toBe("just now");
  });

  it("renders a missing or unparseable timestamp as an em dash", () => {
    expect(formatRelativeTime(null, now)).toBe("—");
    expect(formatRelativeTime("nonsense", now)).toBe("—");
  });
});

describe("greeting", () => {
  it("splits the day at noon and 6pm", () => {
    expect(greeting(9)).toBe("Good morning");
    expect(greeting(12)).toBe("Good afternoon");
    expect(greeting(17)).toBe("Good afternoon");
    expect(greeting(18)).toBe("Good evening");
    expect(greeting(23)).toBe("Good evening");
  });
});

describe("recentRuns", () => {
  it("trims to the sample the dashboard shows", () => {
    const runs = Array.from({ length: 12 }, (_, index) => run(`run-${index}`));
    expect(recentRuns(runs)).toHaveLength(RECENT_RUNS_SHOWN);
  });

  it("handles an undefined query result", () => {
    expect(recentRuns(undefined)).toEqual([]);
  });
});

describe("workflowTiles", () => {
  it("drops archived workflows but keeps drafts", () => {
    const tiles = workflowTiles([workflow("a", "published"), workflow("b", "archived"), workflow("c", "draft")]);
    expect(tiles.map((tile) => tile.id)).toEqual(["a", "c"]);
  });

  it("trims to the tile count", () => {
    const many = Array.from({ length: 20 }, (_, index) => workflow(`w-${index}`, "published"));
    expect(workflowTiles(many)).toHaveLength(WORKFLOW_TILES_SHOWN);
  });

  it("handles an undefined query result", () => {
    expect(workflowTiles(undefined)).toEqual([]);
  });
});
