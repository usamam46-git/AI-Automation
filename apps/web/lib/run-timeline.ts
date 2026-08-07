/**
 * lib/run-timeline.ts — merges a published version's node list with a run's
 * node_executions into the ordered rows the Execution Viewer's timeline renders
 * (Vol. 3 §6.1).
 *
 * Pure module (no React, no network) so it stays vitest-covered.
 *
 * Why a merge is needed at all:
 *  - `NodeExecution` carries only `node_key`, never `node_type`, so the icon
 *    for a row can only come from the version's nodes.
 *  - §6.1's wireframe shows nodes that have NOT run yet (`○ Journal Entry`).
 *    Those have no node_executions row by definition — the version's node list
 *    is their only source. `node_executions.status` is succeeded|failed|skipped
 *    only; there is no stored "pending".
 *
 * Ordering is execution order (created_at) for everything that ran, then the
 * not-yet-run nodes in the version's stored order. This is deliberately NOT a
 * topological sort: an unrun branch has no single correct position, and a wrong
 * confident ordering reads worse than a plainly-appended tail.
 *
 * Retries: node_executions is append-only, so one node_key can hold several
 * rows with a rising `attempt`. The row surfaces the HIGHEST attempt as the
 * live state and reports `attempts` so the UI can say "attempt 3 of 3".
 */

import type { NodeExecution, WorkflowNode, WorkflowRun, WorkflowRunStatus } from "@/lib/api";
import type { NodeType } from "@/lib/api";

export type TimelineRowState = "succeeded" | "failed" | "skipped" | "waiting" | "running" | "pending";

export type TimelineRow = {
  nodeKey: string;
  /** Falls back to "agent" only if a node_execution references a key absent
   *  from the version — which shouldn't happen, but must not crash the page. */
  nodeType: NodeType;
  /** Latest attempt's execution row, or null when the node hasn't run. */
  execution: NodeExecution | null;
  /** Every attempt for this node_key, oldest first. */
  allAttempts: NodeExecution[];
  attempts: number;
  state: TimelineRowState;
};

function latestAttempt(rows: NodeExecution[]): NodeExecution {
  return rows.reduce((best, row) => (row.attempt > best.attempt ? row : best), rows[0]);
}

function byCreatedAt(a: NodeExecution, b: NodeExecution): number {
  const delta = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (!Number.isNaN(delta) && delta !== 0) return delta;
  return a.attempt - b.attempt;
}

/**
 * @param nodes  the run's version's nodes (from GET /workflows/{id}/versions/{versionId})
 * @param run    the run itself; its status and current_node_key decide which
 *               un-executed node reads as "waiting" vs plain "pending"
 */
export function buildTimeline(nodes: WorkflowNode[], run: Pick<WorkflowRun, "status" | "current_node_key" | "node_executions">): TimelineRow[] {
  const nodeTypeByKey = new Map<string, NodeType>(nodes.map((node) => [node.node_key, node.node_type]));

  const executionsByKey = new Map<string, NodeExecution[]>();
  for (const execution of run.node_executions) {
    const bucket = executionsByKey.get(execution.node_key);
    if (bucket) bucket.push(execution);
    else executionsByKey.set(execution.node_key, [execution]);
  }
  for (const bucket of executionsByKey.values()) bucket.sort(byCreatedAt);

  // Executed nodes, ordered by when each node FIRST ran.
  const executedKeys = [...executionsByKey.entries()]
    .sort((a, b) => byCreatedAt(a[1][0], b[1][0]))
    .map(([nodeKey]) => nodeKey);

  const executedRows: TimelineRow[] = executedKeys.map((nodeKey) => {
    const allAttempts = executionsByKey.get(nodeKey)!;
    const execution = latestAttempt(allAttempts);
    return {
      nodeKey,
      nodeType: nodeTypeByKey.get(nodeKey) ?? "agent",
      execution,
      allAttempts,
      attempts: allAttempts.length,
      state: execution.status,
    };
  });

  const unexecuted = nodes.filter((node) => !executionsByKey.has(node.node_key));

  // Which un-executed node is the one currently holding the run open.
  //
  // `current_node_key` is preferred, but it cannot be trusted blindly: on
  // interrupt the execution engine writes the LITERAL string "human_approval"
  // (graph_tasks.py) rather than the node's actual key, so a node keyed
  // `approval_1` never matches. When it doesn't resolve to a real node, fall
  // back to the first un-executed human_approval node — which is what a
  // waiting_approval run is by definition parked on.
  const activeKey = resolveActiveNodeKey(unexecuted, run.status, run.current_node_key);

  // Nodes with no execution row yet, in the version's own order.
  const pendingRows: TimelineRow[] = unexecuted.map((node) => ({
    nodeKey: node.node_key,
    nodeType: node.node_type,
    execution: null,
    allAttempts: [],
    attempts: 0,
    state: node.node_key === activeKey ? activeState(run.status) : "pending",
  }));

  return [...executedRows, ...pendingRows];
}

function resolveActiveNodeKey(unexecuted: WorkflowNode[], runStatus: WorkflowRunStatus, currentNodeKey: string | null): string | null {
  if (runStatus !== "waiting_approval" && runStatus !== "running") return null;
  if (currentNodeKey && unexecuted.some((node) => node.node_key === currentNodeKey)) return currentNodeKey;
  if (runStatus === "waiting_approval") return unexecuted.find((node) => node.node_type === "human_approval")?.node_key ?? null;
  return null;
}

function activeState(runStatus: WorkflowRunStatus): TimelineRowState {
  return runStatus === "waiting_approval" ? "waiting" : "running";
}

/**
 * The node the detail pane should open on: the one that needs attention
 * (waiting), else the most recent failure, else the last node that ran.
 * Returns null for a run that hasn't produced anything yet.
 */
export function defaultSelectedNodeKey(rows: TimelineRow[]): string | null {
  const waiting = rows.find((row) => row.state === "waiting" || row.state === "running");
  if (waiting) return waiting.nodeKey;

  const failed = [...rows].reverse().find((row) => row.state === "failed");
  if (failed) return failed.nodeKey;

  const executed = [...rows].reverse().find((row) => row.execution !== null);
  return executed?.nodeKey ?? rows[0]?.nodeKey ?? null;
}

/** Total tokens across every attempt of every node — the run-level rollup the
 *  header shows next to total_cost_usd (which the backend already aggregates). */
export function totalTokens(executions: NodeExecution[]): { prompt: number; completion: number } | null {
  let prompt = 0;
  let completion = 0;
  let sawAny = false;
  for (const execution of executions) {
    if (execution.tokens_prompt != null) {
      prompt += execution.tokens_prompt;
      sawAny = true;
    }
    if (execution.tokens_completion != null) {
      completion += execution.tokens_completion;
      sawAny = true;
    }
  }
  return sawAny ? { prompt, completion } : null;
}
