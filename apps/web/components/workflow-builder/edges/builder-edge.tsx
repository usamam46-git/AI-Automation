"use client";

import * as React from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  type EdgeProps,
} from "@xyflow/react";
import { Plus, X } from "lucide-react";
import { useBuilderActions } from "@/components/workflow-builder/builder-actions-context";
import type { BuilderEdge } from "@/lib/graph-mapping";

/**
 * The connection between two nodes, with the two gestures n8n puts there: drop a
 * node into the middle of this connection, or cut it.
 *
 * The branch chip is rendered HERE rather than through React Flow's built-in
 * `label`, because the built-in label cannot host buttons and the chip and the
 * controls have to share one hover region — otherwise the controls vanish the
 * moment the pointer crosses onto the label sitting on top of them.
 *
 * Presentation only: the condition itself lives in `edge.data.condition` and is
 * never written from here. `lib/graph-mapping.ts` stays free of styling for the
 * same reason it always has — its output is the autosave payload.
 */
export function BuilderEdgeLine({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
  markerEnd,
  style,
}: EdgeProps<BuilderEdge>) {
  const [hovered, setHovered] = React.useState(false);
  const { insertOnEdge, deleteEdge } = useBuilderActions();

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition: sourcePosition ?? Position.Right,
    targetPosition: targetPosition ?? Position.Left,
  });

  const label = data?.condition ? conditionLabel(data.condition) : null;
  const showControls = hovered || selected;

  return (
    <>
      {/* `style` MUST be forwarded: the dashed stroke comes from
          `defaultEdgeOptions` on the canvas, and a custom edge that drops it
          silently renders every connection solid. */}
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />

      {/* Invisible, generously wide hit area. The visible stroke is 1.5px, which
          is far too thin to hover deliberately. */}
      <path
        d={path}
        fill="none"
        strokeWidth={22}
        stroke="transparent"
        className="react-flow__edge-interaction"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      />

      <EdgeLabelRenderer>
        <div
          // `nodrag nopan` keeps a click here from panning the canvas.
          className="nodrag nopan absolute flex items-center gap-1"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
          }}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
        >
          {label && !showControls ? (
            <span className="rounded-lg bg-card px-1.5 py-0.5 text-[10px] font-medium leading-tight text-foreground">
              {label}
            </span>
          ) : null}

          {showControls ? (
            <>
              <button
                type="button"
                aria-label="Insert a node on this connection"
                onClick={(event) => {
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  insertOnEdge(id, { x: rect.right + 8, y: rect.top });
                }}
                className="flex size-[18px] items-center justify-center rounded-full bg-popover text-muted-foreground shadow-soft transition-colors hover:bg-lime hover:text-lime-ink focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                <Plus className="size-3" />
              </button>
              <button
                type="button"
                aria-label={`Delete the connection from ${source} to ${target}`}
                onClick={(event) => {
                  event.stopPropagation();
                  deleteEdge(id);
                }}
                className="flex size-[18px] items-center justify-center rounded-full bg-popover text-muted-foreground shadow-soft transition-colors hover:bg-status-bad-soft hover:text-status-bad focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                <X className="size-3" />
              </button>
            </>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const builderEdgeTypes = { builder: BuilderEdgeLine };

/** Compact `branch` or `field op value` summary for the chip. */
function conditionLabel(condition: Record<string, unknown>): string {
  const branch = typeof condition.branch === "string" ? condition.branch : "";
  if (branch) return branch;
  const field = typeof condition.field === "string" ? (condition.field.split(".").pop() ?? "") : "";
  const operator = typeof condition.operator === "string" ? condition.operator : "";
  if (!field || !operator) return "rule";
  return `${field} ${operator} ${JSON.stringify(condition.value ?? null)}`;
}
