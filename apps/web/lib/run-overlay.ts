/**
 * lib/run-overlay.ts — a run, projected onto the canvas.
 *
 * Turns a `RunStatus` poll into per-node state and per-edge "was this branch
 * taken", so the builder can light a graph up while it executes.
 *
 * Two things here are INFERRED rather than reported, and both are labelled as
 * such because getting that wrong is how a UI starts lying:
 *
 * - **"running"**. The engine streams with `stream_mode="updates"`, which yields
 *   a chunk only when a node has already finished — so no node can be announced
 *   as it starts. `current_node_key` names the node that most recently
 *   COMPLETED. A node is shown as running when the run is live and it is an
 *   immediate successor of that node with no row of its own yet. That is a good
 *   guess and not a fact, which is why `inferred` rides along on the state.
 * - **"which branch was taken"**. Nothing records the routing decision. An edge
 *   is marked taken when its target has actually executed. On a converging graph
 *   that can credit two incoming edges when only one fired; it never invents a
 *   path to a node that did not run.
 */

import type { NodeExecutionSummary, RunStatus, WorkflowRunStatus } from "@/lib/api";

export type NodeRunState = "pending" | "running" | "succeeded" | "failed" | "waiting" | "skipped";

export type NodeRun = {
  state: NodeRunState;
  /** Latest attempt for this node, or null when it has not run. */
  execution: NodeExecutionSummary | null;
  attempts: number;
  /** True when `state` was deduced rather than read — see the module header. */
  inferred: boolean;
};

export type RunOverlay = {
  runId: string;
  status: WorkflowRunStatus;
  isTest: boolean;
  /** Node key the run is held at, when it is waiting for an approval. */
  waitingAt: string | null;
  nodes: Map<string, NodeRun>;
  /** Edge ids (`source->target`) whose target has executed. */
  takenEdges: Set<string>;
  totalCostUsd: number | null;
};

const TERMINAL: ReadonlySet<WorkflowRunStatus> = new Set<WorkflowRunStatus>([
  "completed",
  "failed",
  "rejected",
  "cancelled",
]);

export function isTerminal(status: WorkflowRunStatus): boolean {
  // An unknown status counts as live, so a status this build has not heard of
  // keeps polling rather than freezing a run that is still going.
  return TERMINAL.has(status);
}

export type OverlayGraph = {
  nodes: readonly { id: string }[];
  edges: readonly { id: string; source: string; target: string }[];
};

export function buildRunOverlay(run: RunStatus, graph: OverlayGraph): RunOverlay {
  const latest = latestPerNode(run.node_executions);
  const attemptCounts = countAttempts(run.node_executions);
  const live = !isTerminal(run.status);

  const waitingAt =
    run.status === "waiting_approval"
      ? (interruptNodeKey(run) ?? run.current_node_key ?? null)
      : null;

  // Successors of the node that most recently completed — the only candidates
  // for "running", and only while the run is still live.
  const running = new Set<string>();
  if (live && run.status === "running" && run.current_node_key) {
    for (const edge of graph.edges) {
      if (edge.source !== run.current_node_key) continue;
      if (latest.has(edge.target)) continue;
      running.add(edge.target);
    }
  }

  const nodes = new Map<string, NodeRun>();
  for (const node of graph.nodes) {
    const execution = latest.get(node.id) ?? null;
    const attempts = attemptCounts.get(node.id) ?? 0;

    if (node.id === waitingAt) {
      nodes.set(node.id, { state: "waiting", execution, attempts, inferred: false });
      continue;
    }
    if (execution) {
      nodes.set(node.id, {
        state: execution.status === "failed" ? "failed" : execution.status === "skipped" ? "skipped" : "succeeded",
        execution,
        attempts,
        inferred: false,
      });
      continue;
    }
    if (running.has(node.id)) {
      nodes.set(node.id, { state: "running", execution: null, attempts: 0, inferred: true });
      continue;
    }
    nodes.set(node.id, { state: "pending", execution: null, attempts: 0, inferred: false });
  }

  const takenEdges = new Set<string>();
  for (const edge of graph.edges) {
    if (latest.has(edge.target) && latest.has(edge.source)) takenEdges.add(edge.id);
  }

  return {
    runId: run.id,
    status: run.status,
    isTest: run.is_test,
    waitingAt,
    nodes,
    takenEdges,
    totalCostUsd: run.total_cost_usd,
  };
}

/**
 * The gate a waiting run is held at.
 *
 * `interrupt_payload.node_key` is the authority — added 2026-08-30 precisely
 * because `current_node_key` used to be the literal string `"human_approval"`,
 * which no graph with two gates could disambiguate. Older runs have no
 * `node_key`, so the caller falls back.
 */
function interruptNodeKey(run: RunStatus): string | null {
  const value = run.interrupt_payload?.node_key;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The most recent attempt per node.
 *
 * `node_executions` is append-only, so a retried node appears several times with
 * a rising `attempt`. The last one is the node's current state — an earlier
 * failure followed by a success must read as succeeded.
 */
function latestPerNode(executions: readonly NodeExecutionSummary[]): Map<string, NodeExecutionSummary> {
  const latest = new Map<string, NodeExecutionSummary>();
  for (const execution of executions) {
    const existing = latest.get(execution.node_key);
    if (!existing || execution.attempt >= existing.attempt) latest.set(execution.node_key, execution);
  }
  return latest;
}

function countAttempts(executions: readonly NodeExecutionSummary[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const execution of executions) {
    counts.set(execution.node_key, (counts.get(execution.node_key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Milliseconds a node took.
 *
 * Prefers the measured `completed_at - started_at`, which is the handler's own
 * wall clock. `latency_ms` is the fallback for rows written before that existed,
 * and it is a whole-SUPERSTEP delta — two nodes in one step carry the same value.
 */
export function nodeDurationMs(execution: NodeExecutionSummary | null): number | null {
  if (!execution) return null;
  if (execution.started_at && execution.completed_at) {
    const measured = Date.parse(execution.completed_at) - Date.parse(execution.started_at);
    if (Number.isFinite(measured) && measured >= 0) return measured;
  }
  return execution.latency_ms;
}

/** Nodes in the order they actually ran, for the run dock. */
export function executionOrder(overlay: RunOverlay, graph: OverlayGraph): string[] {
  const executed = graph.nodes
    .map((node) => ({ id: node.id, run: overlay.nodes.get(node.id) }))
    .filter((entry): entry is { id: string; run: NodeRun } => Boolean(entry.run?.execution));

  executed.sort((a, b) => {
    const left = a.run.execution!.created_at;
    const right = b.run.execution!.created_at;
    return left === right ? a.id.localeCompare(b.id) : left.localeCompare(right);
  });

  return executed.map((entry) => entry.id);
}
