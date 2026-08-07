"use client";

import { Badge } from "@/components/ui/badge";
import { JsonBlock } from "@/components/executions/json-block";
import { NODE_CATALOG } from "@/lib/node-catalog";
import { formatCost, formatDuration, formatTokens } from "@/lib/run-status";
import type { TimelineRow } from "@/lib/run-timeline";

// Deliberately no "View raw trace in LangSmith" link from the §6.1 wireframe:
// the LangSmith hook in LLMClient is a no-op, so the link would be dead.

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm tabular-nums">{value}</span>
    </div>
  );
}

export function NodeDetailPanel({ row }: { row: TimelineRow | null }) {
  if (!row) {
    return <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">Select a node to inspect its input and output.</div>;
  }

  const entry = NODE_CATALOG[row.nodeType];
  const Icon = entry.icon;
  const execution = row.execution;
  const tokens = execution ? formatTokens(execution.tokens_prompt, execution.tokens_completion) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2.5">
        <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${entry.accent}`}><Icon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{row.nodeKey}</h3>
          <p className="truncate text-xs text-muted-foreground">{entry.label}</p>
        </div>
        {row.attempts > 1 ? <Badge variant="outline">{row.attempts} attempts</Badge> : null}
      </div>

      {execution ? (
        <>
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-border p-3 sm:grid-cols-4">
            <Stat label="Status" value={execution.status} />
            <Stat label="Duration" value={formatDuration(execution.latency_ms)} />
            <Stat label="Cost" value={formatCost(execution.cost_usd)} />
            <Stat label="Tokens" value={tokens ?? "—"} />
          </div>

          <div className="flex flex-col gap-1.5">
            <h4 className="text-sm font-medium text-muted-foreground">Input</h4>
            <JsonBlock value={execution.input} emptyLabel="No input snapshot recorded." />
          </div>

          <div className="flex flex-col gap-1.5">
            <h4 className="text-sm font-medium text-muted-foreground">Output</h4>
            <JsonBlock value={execution.output} emptyLabel="No output recorded." />
          </div>
        </>
      ) : (
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
          {row.state === "waiting"
            ? "This node is holding the run open until someone approves or rejects it."
            : row.state === "running"
              ? "This node is executing now."
              : "This node has not run yet."}
        </p>
      )}
    </div>
  );
}
