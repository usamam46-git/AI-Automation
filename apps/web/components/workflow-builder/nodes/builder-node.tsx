"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CircleAlert, Plus } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBuilderActions, useHasOutgoing } from "@/components/workflow-builder/builder-actions-context";
import { useNodeIssues } from "@/components/workflow-builder/issue-context";
import type { BuilderNode, BuilderNodeData } from "@/lib/graph-mapping";
import { NODE_CATALOG } from "@/lib/node-catalog";
import { cn } from "@/lib/utils";

/**
 * One card component registered for all seven node types. The per-type
 * differences — icon, tint, which handles exist — are data in NODE_CATALOG, so
 * seven near-identical files would only be a place for them to drift apart.
 *
 * Flow is LEFT TO RIGHT: target handle on the left edge, source on the right.
 * `builder.css` carries the matching `-left`/`-right` offsets; changing one
 * without the other leaves the handles overlapping the card's rounded border.
 *
 * `data-status` is an idle-only placeholder today; the live-run phase drives it
 * to running/succeeded/failed from `RunOverlayContext` — NOT from `data`, which
 * is the autosave payload.
 */
export function BuilderNodeCard({ data, selected }: NodeProps<BuilderNode>) {
  const entry = NODE_CATALOG[data.nodeType];
  const Icon = entry.icon;
  const issues = useNodeIssues(data.nodeKey);
  const { addAfter } = useBuilderActions();
  const hasOutgoing = useHasOutgoing(data.nodeKey);

  const card = (
    <div
      data-status="idle"
      className={cn(
        // A node is a floating chip on the canvas, so unlike a page Card it DOES
        // take the popover fill and a shadow — it has to read as sitting above
        // the grid rather than as a hole cut in it. That is the one deliberate
        // exception to the borderless-fill rule, and the reference's own nodes
        // are drawn the same way.
        "group relative flex min-w-[210px] max-w-[260px] items-center gap-2.5 rounded-xl bg-popover px-3 py-2.5 shadow-soft transition-shadow",
        "ring-0 ring-offset-2 ring-offset-background",
        issues.length > 0 ? "ring-status-bad" : "ring-ring",
        issues.length > 0 && "ring-2",
        selected && "shadow-pop ring-2",
      )}
    >
      {entry.hasTarget ? <Handle type="target" position={Position.Left} /> : null}

      <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", entry.accent)}>
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-tight">{data.nodeKey}</span>
        <span className="block truncate text-[11px] leading-tight text-muted-foreground">
          {nodeSubtitle(data)}
        </span>
      </span>
      {issues.length > 0 ? <CircleAlert className="size-4 shrink-0 text-status-bad" /> : null}

      {entry.hasSource ? (
        <>
          <Handle type="source" position={Position.Right} />
          {/* Only on an UNCONNECTED output — see `useHasOutgoing` for why that is
              load-bearing and not just an n8n convention. Sits just outside the
              right edge, over the handle's own lane; hidden until the card is
              hovered/selected or the button itself is focused, so a dense graph
              is not a field of plus signs, but it stays reachable by Tab, which
              is the only way to add a node from here without a mouse. */}
          <button
            type="button"
            hidden={hasOutgoing}
            aria-label={`Add a node after ${data.nodeKey}`}
            className={cn(
              "absolute -right-[30px] top-1/2 z-10 flex size-[18px] -translate-y-1/2 items-center justify-center rounded-full",
              "bg-popover text-muted-foreground shadow-soft transition-all",
              "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              "hover:bg-lime hover:text-lime-ink focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
              selected && "opacity-100",
            )}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              addAfter(data.nodeKey, { x: rect.right + 8, y: rect.top });
            }}
          >
            <Plus className="size-3" />
          </button>
        </>
      ) : null}
    </div>
  );

  if (issues.length === 0) return card;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{card}</TooltipTrigger>
      {/* Above, not to the right: the right edge is the ⊕ affordance's lane, and
          a node with issues is exactly the node someone is about to extend, so a
          right-side tooltip covered the button it was sitting next to. */}
      <TooltipContent side="top" className="max-w-xs">
        <span className="flex flex-col gap-1">
          {issues.map((issue) => (
            <span key={issue.rule}>{issue.message}</span>
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The second line of the card. The type label alone was the same word on every
 * node of that type; what someone scanning a graph actually needs is which tool
 * this is and whether it writes.
 */
function nodeSubtitle(data: BuilderNodeData): string {
  const entry = NODE_CATALOG[data.nodeType];
  const config = data.config ?? {};
  const parts: string[] = [];

  if (data.nodeType === "agent") {
    parts.push(typeof config.model === "string" && config.model ? config.model : "default model");
  } else if (data.nodeType === "tool") {
    const toolType = typeof config.tool_type === "string" ? config.tool_type : null;
    // Inline `tool_type` always wins over `tool_id` at the backend, so the card
    // must read them in the same order or it would name a tool that never runs.
    parts.push(toolType ? toolType.replace(/_/g, " ") : config.tool_id ? "registry tool" : entry.label);
  } else {
    parts.push(entry.label);
  }

  if (config.is_mutating === true) parts.push("writes");
  return parts.join(" · ");
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
