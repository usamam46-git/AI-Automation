import { describe, expect, it } from "vitest";
import type { NodeExecutionSummary, RunStatus, WorkflowRunStatus } from "@/lib/api";
import {
  buildRunOverlay,
  executionOrder,
  isTerminal,
  nodeDurationMs,
  type OverlayGraph,
} from "@/lib/run-overlay";

function execution(node_key: string, overrides: Partial<NodeExecutionSummary> = {}): NodeExecutionSummary {
  return {
    id: `exec-${node_key}-${overrides.attempt ?? 1}`,
    node_key,
    status: "succeeded",
    tokens_prompt: null,
    tokens_completion: null,
    cost_usd: null,
    latency_ms: 10,
    attempt: 1,
    started_at: null,
    completed_at: null,
    created_at: "2026-08-30T09:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<RunStatus> = {}): RunStatus {
  return {
    id: "run-1",
    status: "running",
    current_node_key: null,
    interrupt_payload: null,
    started_at: "2026-08-30T09:00:00.000Z",
    completed_at: null,
    total_cost_usd: null,
    error: null,
    is_test: false,
    test_until_node_key: null,
    node_executions: [],
    ...overrides,
  };
}

const graph: OverlayGraph = {
  nodes: [{ id: "start_1" }, { id: "extract" }, { id: "check" }, { id: "post" }, { id: "end_1" }],
  edges: [
    { id: "start_1->extract", source: "start_1", target: "extract" },
    { id: "extract->check", source: "extract", target: "check" },
    { id: "check->post", source: "check", target: "post" },
    { id: "post->end_1", source: "post", target: "end_1" },
  ],
};

describe("isTerminal", () => {
  it("recognises the settled statuses", () => {
    for (const status of ["completed", "failed", "rejected", "cancelled"] as WorkflowRunStatus[]) {
      expect(isTerminal(status)).toBe(true);
    }
  });

  it("treats in-flight statuses as live", () => {
    for (const status of ["pending", "running", "waiting_approval"] as WorkflowRunStatus[]) {
      expect(isTerminal(status)).toBe(false);
    }
  });

  it("treats an unknown status as live, so polling does not freeze a live run", () => {
    expect(isTerminal("something_new" as WorkflowRunStatus)).toBe(false);
  });
});

describe("buildRunOverlay", () => {
  it("marks every node pending before anything has run", () => {
    const overlay = buildRunOverlay(run(), graph);
    expect([...overlay.nodes.values()].every((entry) => entry.state === "pending")).toBe(true);
  });

  it("marks an executed node succeeded", () => {
    const overlay = buildRunOverlay(run({ node_executions: [execution("start_1")] }), graph);
    expect(overlay.nodes.get("start_1")?.state).toBe("succeeded");
    expect(overlay.nodes.get("extract")?.state).not.toBe("succeeded");
  });

  it("marks a failed node failed", () => {
    const overlay = buildRunOverlay(
      run({ status: "failed", node_executions: [execution("extract", { status: "failed" })] }),
      graph,
    );
    expect(overlay.nodes.get("extract")?.state).toBe("failed");
  });

  it("uses the LATEST attempt, so a retry that succeeded reads as succeeded", () => {
    const overlay = buildRunOverlay(
      run({
        node_executions: [
          execution("extract", { status: "failed", attempt: 1 }),
          execution("extract", { status: "succeeded", attempt: 2 }),
        ],
      }),
      graph,
    );
    expect(overlay.nodes.get("extract")?.state).toBe("succeeded");
    expect(overlay.nodes.get("extract")?.attempts).toBe(2);
  });

  it("infers the running node as a successor of the last completed one", () => {
    const overlay = buildRunOverlay(
      run({ status: "running", current_node_key: "start_1", node_executions: [execution("start_1")] }),
      graph,
    );
    expect(overlay.nodes.get("extract")?.state).toBe("running");
  });

  it("LABELS that inference, because updates-mode cannot announce a node as it starts", () => {
    const overlay = buildRunOverlay(
      run({ status: "running", current_node_key: "start_1", node_executions: [execution("start_1")] }),
      graph,
    );
    expect(overlay.nodes.get("extract")?.inferred).toBe(true);
    expect(overlay.nodes.get("start_1")?.inferred).toBe(false);
  });

  it("never infers a running node on a finished run", () => {
    const overlay = buildRunOverlay(
      run({ status: "completed", current_node_key: "start_1", node_executions: [execution("start_1")] }),
      graph,
    );
    expect(overlay.nodes.get("extract")?.state).toBe("pending");
  });

  it("does not mark a node running when it already has a row", () => {
    const overlay = buildRunOverlay(
      run({ status: "running", current_node_key: "start_1", node_executions: [execution("start_1"), execution("extract")] }),
      graph,
    );
    expect(overlay.nodes.get("extract")?.state).toBe("succeeded");
  });

  it("reads the held gate off interrupt_payload.node_key", () => {
    const overlay = buildRunOverlay(
      run({ status: "waiting_approval", interrupt_payload: { node_key: "check" }, current_node_key: "check" }),
      graph,
    );
    expect(overlay.waitingAt).toBe("check");
    expect(overlay.nodes.get("check")?.state).toBe("waiting");
  });

  it("falls back to current_node_key for a run recorded before node_key existed", () => {
    const overlay = buildRunOverlay(
      run({ status: "waiting_approval", interrupt_payload: { type: "approval_request" }, current_node_key: "check" }),
      graph,
    );
    expect(overlay.waitingAt).toBe("check");
  });

  it("shows the gate as waiting even though it has already produced a row on resume", () => {
    // The gate writes its decision row, so "executed" must not beat "waiting".
    const overlay = buildRunOverlay(
      run({
        status: "waiting_approval",
        interrupt_payload: { node_key: "check" },
        node_executions: [execution("check")],
      }),
      graph,
    );
    expect(overlay.nodes.get("check")?.state).toBe("waiting");
  });

  it("marks an edge taken only when BOTH ends have executed", () => {
    const overlay = buildRunOverlay(
      run({ node_executions: [execution("start_1"), execution("extract")] }),
      graph,
    );
    expect(overlay.takenEdges.has("start_1->extract")).toBe(true);
    expect(overlay.takenEdges.has("extract->check")).toBe(false);
  });

  it("carries the test flag and cost through", () => {
    const overlay = buildRunOverlay(run({ is_test: true, total_cost_usd: 0.0042 }), graph);
    expect(overlay.isTest).toBe(true);
    expect(overlay.totalCostUsd).toBe(0.0042);
  });

  it("ignores executions for nodes that are no longer on the canvas", () => {
    // The graph can be edited while a run of an older version is on screen.
    const overlay = buildRunOverlay(run({ node_executions: [execution("deleted_node")] }), graph);
    expect(overlay.nodes.has("deleted_node")).toBe(false);
    expect(overlay.nodes.size).toBe(graph.nodes.length);
  });
});

describe("nodeDurationMs", () => {
  it("prefers the measured handler wall clock", () => {
    const measured = execution("a", {
      started_at: "2026-08-30T09:00:00.000Z",
      completed_at: "2026-08-30T09:00:01.500Z",
      latency_ms: 99999,
    });
    expect(nodeDurationMs(measured)).toBe(1500);
  });

  it("falls back to latency_ms for a row written before timings existed", () => {
    expect(nodeDurationMs(execution("a", { latency_ms: 250 }))).toBe(250);
  });

  it("falls back when only one timestamp is present", () => {
    expect(nodeDurationMs(execution("a", { started_at: "2026-08-30T09:00:00.000Z", latency_ms: 7 }))).toBe(7);
  });

  it("falls back rather than reporting a negative duration", () => {
    const skewed = execution("a", {
      started_at: "2026-08-30T09:00:05.000Z",
      completed_at: "2026-08-30T09:00:00.000Z",
      latency_ms: 42,
    });
    expect(nodeDurationMs(skewed)).toBe(42);
  });

  it("is null for a node that has not run", () => {
    expect(nodeDurationMs(null)).toBeNull();
  });
});

describe("executionOrder", () => {
  it("lists executed nodes in the order they ran", () => {
    const status = run({
      node_executions: [
        execution("extract", { created_at: "2026-08-30T09:00:02.000Z" }),
        execution("start_1", { created_at: "2026-08-30T09:00:01.000Z" }),
      ],
    });
    expect(executionOrder(buildRunOverlay(status, graph), graph)).toEqual(["start_1", "extract"]);
  });

  it("excludes nodes that have not run", () => {
    const status = run({ node_executions: [execution("start_1")] });
    expect(executionOrder(buildRunOverlay(status, graph), graph)).toEqual(["start_1"]);
  });

  it("is deterministic when two nodes share a timestamp", () => {
    const status = run({
      node_executions: [
        execution("post", { created_at: "2026-08-30T09:00:01.000Z" }),
        execution("extract", { created_at: "2026-08-30T09:00:01.000Z" }),
      ],
    });
    expect(executionOrder(buildRunOverlay(status, graph), graph)).toEqual(["extract", "post"]);
  });
});
