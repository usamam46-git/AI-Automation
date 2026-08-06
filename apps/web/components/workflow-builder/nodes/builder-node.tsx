"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CircleAlert } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNodeIssues } from "@/components/workflow-builder/issue-context";
import type { BuilderNode } from "@/lib/graph-mapping";
import { NODE_CATALOG } from "@/lib/node-catalog";
import { cn } from "@/lib/utils";

/**
 * One card component registered for all seven node types. The per-type
 * differences — icon, tint, which handles exist — are data in NODE_CATALOG, so
 * seven near-identical files would only be a place for them to drift apart.
 *
 * `data-status` is an idle-only placeholder today; the Execution Viewer phase
 * drives it to running/succeeded/failed.
 */
export function BuilderNodeCard({ data, selected }: NodeProps<BuilderNode>) {
  const entry = NODE_CATALOG[data.nodeType];
  const Icon = entry.icon;
  const issues = useNodeIssues(data.nodeKey);
  const isMutating = data.config?.is_mutating === true;

  const card = (
    <div
      data-status="idle"
      className={cn(
        "group flex min-w-[190px] items-center gap-2.5 rounded-xl border bg-card px-3 py-2 shadow-sm shadow-black/5 transition-shadow",
        "ring-0 ring-offset-2 ring-offset-background",
        issues.length > 0 ? "border-destructive/50 ring-destructive/50" : "border-border ring-ring/40",
        issues.length > 0 && "ring-2",
        selected && "shadow-md shadow-black/10 ring-2",
      )}
    >
      {entry.hasTarget ? <Handle type="target" position={Position.Top} /> : null}

      <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", entry.accent)}>
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-tight">{data.nodeKey}</span>
        <span className="block truncate text-[11px] leading-tight text-muted-foreground">
          {entry.label}
          {isMutating ? " · writes" : ""}
        </span>
      </span>
      {issues.length > 0 ? <CircleAlert className="size-4 shrink-0 text-destructive" /> : null}

      {entry.hasSource ? <Handle type="source" position={Position.Bottom} /> : null}
    </div>
  );

  if (issues.length === 0) return card;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{card}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        <span className="flex flex-col gap-1">
          {issues.map((issue) => (
            <span key={issue.rule}>{issue.message}</span>
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

export const builderNodeTypes = {
  start: BuilderNodeCard,
  agent: BuilderNodeCard,
  tool: BuilderNodeCard,
  condition: BuilderNodeCard,
  human_approval: BuilderNodeCard,
  subgraph: BuilderNodeCard,
  end: BuilderNodeCard,
};
