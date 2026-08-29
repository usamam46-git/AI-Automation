import { describe, expect, it } from "vitest";
import { buildTimeline, defaultSelectedNodeKey, totalTokens } from "@/lib/run-timeline";
import type { NodeExecution, NodeType, WorkflowNode, WorkflowRunStatus } from "@/lib/api";

function node(node_key: string, node_type: NodeType): WorkflowNode {
  return { id: `id-${node_key}`, node_key, node_type, config: {}, position_x: 0, position_y: 0 };
}

function execution(node_key: string, overrides: Partial<NodeExecution> = {}): NodeExecution {
  return {
    id: `exec-${node_key}-${overrides.attempt ?? 1}`,
    node_key,
    status: "succeeded",
    input: null,
    output: null,
    tokens_prompt: null,
    tokens_completion: null,
    cost_usd: null,
    latency_ms: 10,
    attempt: 1,
    started_at: null,
    completed_at: null,
    created_at: "2026-08-07T09:00:00.000Z",
    ...overrides,
  };
}

function run(node_executions: NodeExecution[], status: WorkflowRunStatus = "running", current_node_key: string | null = null) {
  return { status, current_node_key, node_executions };
}

const GRAPH = [node("start", "start"), node("extract", "agent"), node("approval", "human_approval"), node("post", "tool"), node("end", "end")];

describe("buildTimeline", () => {
  it("resolves each row's node_type from the version, since NodeExecution has none", () => {
    const rows = buildTimeline(GRAPH, run([execution("start"), execution("extract", { created_at: "2026-08-07T09:00:01.000Z" })]));
    expect(rows.slice(0, 2).map((r) => [r.nodeKey, r.nodeType])).toEqual([
      ["start", "start"],
      ["extract", "agent"],
    ]);
  });

  it("includes nodes that have not run yet as pending (§6.1's `○` rows)", () => {
    // node_executions.status is succeeded|failed|skipped only — there is no
    // stored "pending", so these rows can only come from the version's nodes.
    const rows = buildTimeline(GRAPH, run([execution("start")]));
    expect(rows.map((r) => r.nodeKey)).toEqual(["start", "extract", "approval", "post", "end"]);
    expect(rows.filter((r) => r.state === "pending").map((r) => r.nodeKey)).toEqual(["extract", "approval", "post", "end"]);
  });

  it("orders executed nodes by when they first ran, not by the version's order", () => {
    const rows = buildTimeline(GRAPH, run([execution("post", { created_at: "2026-08-07T09:00:05.000Z" }), execution("start", { created_at: "2026-08-07T09:00:01.000Z" })]));
    expect(rows.slice(0, 2).map((r) => r.nodeKey)).toEqual(["start", "post"]);
  });

  it("collapses append-only retries onto the highest attempt while keeping the history", () => {
    const rows = buildTimeline(
      GRAPH,
      run([
        execution("extract", { attempt: 1, status: "failed", created_at: "2026-08-07T09:00:01.000Z" }),
        execution("extract", { attempt: 2, status: "succeeded", created_at: "2026-08-07T09:00:02.000Z" }),
      ]),
    );
    const extract = rows.find((r) => r.nodeKey === "extract")!;
    expect(extract.attempts).toBe(2);
    expect(extract.execution?.attempt).toBe(2);
    expect(extract.state).toBe("succeeded");
    expect(extract.allAttempts.map((e) => e.attempt)).toEqual([1, 2]);
  });

  it("marks the current node as waiting when the run is paused on approval", () => {
    const rows = buildTimeline(GRAPH, run([execution("start")], "waiting_approval", "approval"));
    expect(rows.find((r) => r.nodeKey === "approval")!.state).toBe("waiting");
    expect(rows.find((r) => r.nodeKey === "post")!.state).toBe("pending");
  });

  it("still finds the waiting node when current_node_key is the engine's hardcoded literal", () => {
    // graph_tasks.py writes current_node_key="human_approval" verbatim on
    // interrupt, which matches no real node_key unless the author happened to
    // name it that. Falling back to the un-executed human_approval node is what
    // keeps the waiting row highlighted for a node keyed `approval`.
    const rows = buildTimeline(GRAPH, run([execution("start")], "waiting_approval", "human_approval"));
    expect(rows.find((r) => r.nodeKey === "approval")!.state).toBe("waiting");
  });

  it("does not invent a waiting node when current_node_key is missing entirely", () => {
    const rows = buildTimeline(GRAPH, run([execution("start")], "running", null));
    expect(rows.filter((r) => r.state === "running")).toHaveLength(0);
  });

  it("leaves un-reached nodes pending on a terminal run", () => {
    const rows = buildTimeline(GRAPH, run([execution("start")], "rejected", "approval"));
    expect(rows.find((r) => r.nodeKey === "approval")!.state).toBe("pending");
  });

  it("does not crash when an execution references a node_key absent from the version", () => {
    const rows = buildTimeline(GRAPH, run([execution("ghost")]));
    expect(rows[0].nodeKey).toBe("ghost");
    expect(rows[0].nodeType).toBe("agent");
  });

  it("returns every node as pending for a run that has not produced anything", () => {
    const rows = buildTimeline(GRAPH, run([], "pending"));
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.execution === null)).toBe(true);
  });
});

describe("defaultSelectedNodeKey", () => {
  it("opens on the node needing attention first", () => {
    const rows = buildTimeline(GRAPH, run([execution("start")], "waiting_approval", "approval"));
    expect(defaultSelectedNodeKey(rows)).toBe("approval");
  });

  it("falls back to the most recent failure", () => {
    const rows = buildTimeline(
      GRAPH,
      run([execution("start"), execution("extract", { status: "failed", created_at: "2026-08-07T09:00:01.000Z" })], "failed"),
    );
    expect(defaultSelectedNodeKey(rows)).toBe("extract");
  });

  it("otherwise opens on the last node that actually ran", () => {
    const rows = buildTimeline(GRAPH, run([execution("start"), execution("extract", { created_at: "2026-08-07T09:00:01.000Z" })], "completed"));
    expect(defaultSelectedNodeKey(rows)).toBe("extract");
  });

  it("returns null for an empty timeline", () => {
    expect(defaultSelectedNodeKey([])).toBeNull();
  });
});

describe("totalTokens", () => {
  it("returns null when no node reported usage", () => {
    expect(totalTokens([execution("start"), execution("post")])).toBeNull();
  });

  it("sums across every attempt, counting a retry's tokens as really spent", () => {
    const total = totalTokens([
      execution("extract", { attempt: 1, tokens_prompt: 100, tokens_completion: 20 }),
      execution("extract", { attempt: 2, tokens_prompt: 110, tokens_completion: 25 }),
    ]);
    expect(total).toEqual({ prompt: 210, completion: 45 });
  });
});
