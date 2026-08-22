"use client";

import { Check, CircleDashed, Hourglass, LoaderCircle, SkipForward, X } from "lucide-react";
import { NODE_CATALOG } from "@/lib/node-catalog";
import { formatCost, formatDuration } from "@/lib/run-status";
import type { TimelineRow, TimelineRowState } from "@/lib/run-timeline";
import { cn } from "@/lib/utils";

// Node icons come from NODE_CATALOG so the viewer and the builder canvas speak
// one visual language (Vol. 3 §6.1) — never redefine the taxonomy here.

// State glyphs read the same `--color-status-*` tokens as the run badges, so a
// row's tick and its status chip cannot end up different greens.
const STATE_GLYPH: Record<TimelineRowState, { icon: typeof Check; className: string }> = {
  succeeded: { icon: Check, className: "text-status-ok" },
  failed: { icon: X, className: "text-status-bad" },
  skipped: { icon: SkipForward, className: "text-muted-foreground" },
  waiting: { icon: Hourglass, className: "text-status-warn" },
  running: { icon: LoaderCircle, className: "text-status-info animate-spin" },
  pending: { icon: CircleDashed, className: "text-muted-foreground/50" },
};

function metaLine(row: TimelineRow): string | null {
  if (row.state === "waiting") return "waiting for approval";
  if (row.state === "running") return "running";
  if (!row.execution) return null;
  const parts = [formatDuration(row.execution.latency_ms)];
  if (row.execution.cost_usd != null) parts.push(formatCost(row.execution.cost_usd));
  if (row.attempts > 1) parts.push(`attempt ${row.execution.attempt}`);
  return parts.join(" · ");
}

export function ExecutionTimeline({ rows, selectedNodeKey, onSelect }: { rows: TimelineRow[]; selectedNodeKey: string | null; onSelect: (nodeKey: string) => void }) {
  return (
    <ol className="flex flex-col">
      {rows.map((row, index) => {
        const entry = NODE_CATALOG[row.nodeType];
        const Icon = entry.icon;
        const glyph = STATE_GLYPH[row.state];
        const Glyph = glyph.icon;
        const selected = row.nodeKey === selectedNodeKey;
        const meta = metaLine(row);

        return (
          <li key={row.nodeKey}>
            <button
              type="button"
              onClick={() => onSelect(row.nodeKey)}
              aria-current={selected}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-xl p-2.5 text-left transition-colors hover:bg-surface-2",
                selected && "bg-surface-2",
                row.state === "pending" && "opacity-60",
              )}
            >
              <span className="relative flex flex-col items-center self-stretch">
                <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-xl", entry.accent)}><Icon className="size-4" /></span>
                {index < rows.length - 1 ? <span className="mt-1 w-px flex-1 bg-border" aria-hidden /> : null}
              </span>
              <span className="min-w-0 flex-1 pb-3">
                <span className="flex items-center gap-1.5">
                  <Glyph className={cn("size-3.5 shrink-0", glyph.className)} />
                  <span className="truncate text-sm font-medium">{row.nodeKey}</span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">{meta ?? entry.label}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
