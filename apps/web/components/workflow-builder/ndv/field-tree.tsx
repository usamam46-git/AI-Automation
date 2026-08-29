"use client";

import * as React from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatScalar, type PreviewNode } from "@/lib/data-preview";
import { FIELD_DRAG_MIME, serializeFieldDrag } from "@/lib/field-drag";
import { cn } from "@/lib/utils";

/**
 * The expandable field tree shared by the Schema and JSON views of both data
 * panels.
 *
 * Every row is keyed by its **dotted state path**, which is the thing the
 * builder is actually for: it is what a drag writes into a parameter. Phase 3
 * turns each row into a drag source; the `path` is already carried here so that
 * step is additive.
 *
 * A row whose path cannot be resolved (`addressable: false` — some segment
 * contains a dot, which `resolve_field_path` splits on) is rendered muted with a
 * warning rather than hidden. Hiding it would leave someone hunting for a field
 * they can plainly see in the raw JSON.
 */
export function FieldTree({
  nodes,
  showValues,
  depth = 0,
}: {
  nodes: readonly PreviewNode[];
  /** JSON view shows the value beside each key; Schema view shows only the type. */
  showValues: boolean;
  depth?: number;
}) {
  if (nodes.length === 0) return null;

  return (
    <ul className={cn("flex flex-col", depth > 0 && "ml-3 border-l border-border pl-2")}>
      {nodes.map((node) => (
        <FieldRow key={node.path} node={node} showValues={showValues} depth={depth} />
      ))}
    </ul>
  );
}

function FieldRow({
  node,
  showValues,
  depth,
}: {
  node: PreviewNode;
  showValues: boolean;
  depth: number;
}) {
  const hasChildren = node.children.length > 0;
  // Deep trees collapse themselves: two levels open is enough to see the shape
  // without turning a retrieval result into three screens of scrolling.
  const [open, setOpen] = React.useState(depth < 2);

  return (
    <li className="min-w-0">
      <div
        // Addressable rows are drag sources. What travels is the dotted PATH,
        // not a value and not an expression — see lib/field-drag.ts.
        draggable={node.addressable}
        onDragStart={(event) => {
          event.dataTransfer.setData(
            FIELD_DRAG_MIME,
            serializeFieldDrag({ path: node.path, key: node.key, kind: node.kind }),
          );
          event.dataTransfer.effectAllowed = "copy";
        }}
        className={cn(
          "group flex min-w-0 items-center gap-1 rounded-lg py-[3px] pl-0.5 pr-1 hover:bg-foreground/8",
          node.addressable && "cursor-grab active:cursor-grabbing",
        )}
        title={node.addressable ? node.path : undefined}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={open ? `Collapse ${node.key}` : `Expand ${node.key}`}
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
          </button>
        ) : (
          <span className="size-4 shrink-0" aria-hidden />
        )}

        <span
          className={cn(
            "truncate font-mono text-[11px] leading-tight",
            node.addressable ? "text-foreground" : "text-muted-foreground line-through",
          )}
        >
          {node.key}
        </span>

        <KindChip kind={node.kind} />

        {showValues && !hasChildren ? (
          <span className="min-w-0 flex-1 truncate text-[11px] leading-tight text-muted-foreground">
            {formatScalar(node.value)}
          </span>
        ) : (
          <span className="flex-1" aria-hidden />
        )}

        {node.addressable ? null : (
          <Tooltip>
            <TooltipTrigger asChild>
              <TriangleAlert className="size-3 shrink-0 text-status-warn" />
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs">
              This field cannot be referenced. A state path is split on “.”, so a key that
              contains a dot can never be resolved.
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {hasChildren && open ? (
        <FieldTree nodes={node.children} showValues={showValues} depth={depth + 1} />
      ) : null}
    </li>
  );
}

/**
 * Type chip. Deliberately NOT the `--status-*` set: those mean run outcomes
 * (ok / warn / bad) everywhere else in the app, and a green "boolean" chip
 * beside a red "failed" pill would be two vocabularies in one colour.
 */
function KindChip({ kind }: { kind: PreviewNode["kind"] }) {
  return (
    <span className="shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase leading-tight tracking-wide text-muted-foreground">
      {kind}
    </span>
  );
}
