"use client";

import * as React from "react";
import { CircleCheck, CircleX, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useBuilderActions } from "@/components/workflow-builder/builder-actions-context";
import type { BuilderGraph } from "@/lib/graph-mapping";
import { NODE_CATALOG } from "@/lib/node-catalog";
import { executionOrder, isTerminal, nodeDurationMs, type RunOverlay } from "@/lib/run-overlay";
import { elapsedMs, formatCost, formatDuration, runStatusMeta } from "@/lib/run-status";
import { cn } from "@/lib/utils";

/**
 * The run, along the bottom of the canvas: what happened, in order, while it
 * happens.
 *
 * Deliberately a dock rather than a navigation. Running a workflow used to send
 * you to `/executions/{id}`, which is the right page for auditing a past run and
 * the wrong one for authoring: you lose the graph you were editing at exactly
 * the moment its behaviour becomes observable.
 */
export function RunDock({
  overlay,
  graph,
  startedAt,
  onApprove,
  onReject,
  approvePending,
  onClose,
}: {
  overlay: RunOverlay;
  graph: BuilderGraph;
  startedAt: string | null;
  onApprove: () => void;
  onReject: () => void;
  approvePending: boolean;
  onClose: () => void;
}) {
  const meta = runStatusMeta(overlay.status);
  const order = React.useMemo(
    () => executionOrder(overlay, { nodes: graph.nodes, edges: graph.edges }),
    [graph.edges, graph.nodes, overlay],
  );
  const live = !isTerminal(overlay.status);

  return (
    <div className="absolute inset-x-0 bottom-0 z-20 flex max-h-[45%] flex-col rounded-t-2xl bg-popover shadow-pop">
      <header className="flex shrink-0 items-center gap-2 px-3 py-2">
        <Badge variant={meta.variant}>{meta.label}</Badge>
        {overlay.isTest ? <Badge variant="outline">test</Badge> : null}

        <span className="text-[11px] text-muted-foreground">
          {/* A live run's duration ticks against now — `elapsedMs` treats a null
              end as "still going", which is what makes the header move. */}
          {formatDuration(elapsedMs(startedAt, null))}
          {overlay.totalCostUsd ? ` · ${formatCost(overlay.totalCostUsd)}` : null}
        </span>

        {overlay.waitingAt ? (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] text-status-warn">
              Held at <span className="font-mono">{overlay.waitingAt}</span>
            </span>
            <Button size="sm" className="h-7" disabled={approvePending} onClick={onApprove}>
              Approve
            </Button>
            <Button variant="outline" size="sm" className="h-7" disabled={approvePending} onClick={onReject}>
              Reject
            </Button>
          </div>
        ) : (
          <span className="ml-auto" aria-hidden />
        )}

        <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label="Close run" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>

      <div className="h-px shrink-0 bg-border" />

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {order.length === 0 ? (
          <p className="px-2 py-4 text-center text-[11px] text-muted-foreground">
            {live ? "Waiting for the first step to finish…" : "No step produced output."}
          </p>
        ) : (
          order.map((nodeKey) => (
            <RunRow key={nodeKey} nodeKey={nodeKey} overlay={overlay} graph={graph} />
          ))
        )}
      </div>
    </div>
  );
}

function RunRow({
  nodeKey,
  overlay,
  graph,
}: {
  nodeKey: string;
  overlay: RunOverlay;
  graph: BuilderGraph;
}) {
  const { openNode } = useBuilderActions();
  const run = overlay.nodes.get(nodeKey);
  const node = graph.nodes.find((item) => item.id === nodeKey);
  if (!run || !node) return null;

  const entry = NODE_CATALOG[node.data.nodeType];
  const Icon = entry.icon;
  const duration = nodeDurationMs(run.execution);

  return (
    <button
      type="button"
      // Opening the step is the point of the row: the detail view then shows the
      // real input and output this run produced, not the declared shape.
      onClick={() => openNode(nodeKey)}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-foreground/8"
    >
      <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-md", entry.accent)}>
        <Icon className="size-3" />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{nodeKey}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {duration !== null ? formatDuration(duration) : null}
        {run.execution?.cost_usd ? ` · ${formatCost(run.execution.cost_usd)}` : null}
        {run.attempts > 1 ? ` · attempt ${run.attempts}` : null}
      </span>
      <StateGlyph state={run.state} />
    </button>
  );
}

function StateGlyph({ state }: { state: string }) {
  if (state === "running") return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-status-info" />;
  if (state === "failed") return <CircleX className="size-3.5 shrink-0 text-status-bad" />;
  if (state === "waiting") return <TriangleAlert className="size-3.5 shrink-0 text-status-warn" />;
  if (state === "succeeded") return <CircleCheck className="size-3.5 shrink-0 text-status-ok" />;
  return <span className="size-3.5 shrink-0" aria-hidden />;
}
