"use client";

import type { NodeType } from "@/lib/api";
import { NODE_CATALOG, PALETTE_ORDER } from "@/lib/node-catalog";
import { cn } from "@/lib/utils";

export const NODE_DRAG_MIME = "application/x-workflow-node-type";

export function NodePalette({ className, onAdd }: { className?: string; onAdd: (nodeType: NodeType) => void }) {
  return (
    <aside className={cn("flex w-52 shrink-0 flex-col border-r border-border bg-background", className)}>
      <div className="border-b border-border px-3 py-2">
        <h3 className="app-eyebrow">Nodes</h3>
      </div>
      <div className="flex flex-col gap-1 overflow-y-auto p-2">
        {PALETTE_ORDER.map((nodeType) => {
          const entry = NODE_CATALOG[nodeType];
          const Icon = entry.icon;
          return (
            <button
              key={nodeType}
              type="button"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(NODE_DRAG_MIME, nodeType);
                event.dataTransfer.effectAllowed = "move";
              }}
              // Click adds to the canvas centre — dragging is the primary
              // gesture, but a click target keeps this usable by keyboard.
              onClick={() => onAdd(nodeType)}
              title={entry.description}
              className="flex cursor-grab items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm transition-colors hover:bg-card focus:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 active:cursor-grabbing"
            >
              <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", entry.accent)}>
                <Icon className="size-3.5" />
              </span>
              <span className="truncate">{entry.label}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-auto border-t border-border p-3 text-[11px] leading-snug text-muted-foreground">
        Drag onto the canvas, or click to drop one in the centre. Connect nodes by dragging between handles.
      </p>
    </aside>
  );
}
