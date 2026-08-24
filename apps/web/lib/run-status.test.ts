import { describe, expect, it } from "vitest";
import { RUN_STATUS_META, elapsedMs, formatCost, formatDuration, formatTokens, isTerminalRunStatus, runStatusMeta } from "@/lib/run-status";
import type { WorkflowRunStatus } from "@/lib/api";

const ALL_STATUSES: WorkflowRunStatus[] = ["pending", "running", "waiting_approval", "completed", "failed", "cancelled", "rejected"];

describe("isTerminalRunStatus", () => {
  it("treats exactly the four settled statuses as terminal", () => {
    // These four are what stop polling. Getting this set wrong either polls
    // forever or freezes the UI mid-run.
    const terminal = ALL_STATUSES.filter(isTerminalRunStatus);
    expect(terminal.sort()).toEqual(["cancelled", "completed", "failed", "rejected"]);
  });

  it("keeps polling on an unknown status rather than freezing", () => {
    expect(isTerminalRunStatus("some_future_status")).toBe(false);
  });
});

describe("RUN_STATUS_META", () => {
  it("covers every status the backend can emit", () => {
    for (const status of ALL_STATUSES) expect(RUN_STATUS_META[status]).toBeDefined();
  });

  it("names a badge variant equal to the status key, so badge.tsx stays in sync", () => {
    for (const status of ALL_STATUSES) expect(RUN_STATUS_META[status].variant).toBe(status);
  });

  it("falls back to a renderable shape for an unknown status", () => {
    const meta = runStatusMeta("nonsense");
    expect(meta.label).toBe("nonsense");
    expect(meta.terminal).toBe(false);
  });
});

describe("formatDuration", () => {
  it("renders sub-second as ms and seconds to one decimal (the §6.1 `1.2s` form)", () => {
    expect(formatDuration(840)).toBe("840ms");
    expect(formatDuration(1200)).toBe("1.2s");
  });

  it("switches to minutes past 60s", () => {
    expect(formatDuration(124_000)).toBe("2m 4s");
  });

  it("carries the seconds remainder instead of rendering `1m 60s`", () => {
    // Rounding the remainder rather than the total produced "1m 60s" here.
    expect(formatDuration(119_600)).toBe("2m 0s");
    expect(formatDuration(59_960)).toBe("1m 0s");
    expect(formatDuration(119_400)).toBe("1m 59s");
  });

  it("goes up to hours and days, because a run waits on a human", () => {
    // A claim approved five days after it was raised rendered "7080m 38s".
    expect(formatDuration(11_520_000)).toBe("3h 12m");
    expect(formatDuration(424_838_000)).toBe("4d 22h");
    expect(formatDuration(3_600_000)).toBe("1h 0m");
  });

  it("renders an em dash for null/invalid rather than NaN", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("formatCost", () => {
  it("keeps sub-cent costs visible instead of collapsing them to $0.00", () => {
    // Numeric(12,6) server-side; a plain 2dp format would erase every agent node.
    expect(formatCost(0.0142)).toBe("$0.0142");
    expect(formatCost(0.000015)).toBe("$0.0000");
  });

  it("distinguishes a real zero cost from a missing one", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(null)).toBe("—");
  });

  it("uses 2dp once past a cent", () => {
    expect(formatCost(4.2)).toBe("$4.20");
  });
});

describe("elapsedMs", () => {
  it("measures a finished span from its two timestamps", () => {
    expect(elapsedMs("2026-08-07T09:00:00Z", "2026-08-07T09:00:03Z")).toBe(3000);
  });

  it("measures an unfinished run against the injected now", () => {
    const now = Date.parse("2026-08-07T09:00:05Z");
    expect(elapsedMs("2026-08-07T09:00:00Z", null, now)).toBe(5000);
  });

  it("returns null when the run never started", () => {
    expect(elapsedMs(null, null)).toBeNull();
  });

  it("never returns a negative span", () => {
    expect(elapsedMs("2026-08-07T09:00:03Z", "2026-08-07T09:00:00Z")).toBe(0);
  });
});

describe("formatTokens", () => {
  it("returns null when a node reported no token usage at all", () => {
    // Tool/condition/approval nodes leave both columns NULL by design.
    expect(formatTokens(null, null)).toBeNull();
  });

  it("treats a missing half as zero rather than dropping the row", () => {
    expect(formatTokens(120, null)).toBe("120 in / 0 out");
  });
});
