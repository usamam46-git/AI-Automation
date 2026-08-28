"use client";

import * as React from "react";
import { Search } from "lucide-react";
import type { NodeType } from "@/lib/api";
import { searchNodeCatalog, type NodeSearchFilter } from "@/lib/node-catalog";
import { cn } from "@/lib/utils";

/**
 * The node picker — opened by the ⊕ on a node's output handle, by dropping a
 * connection on empty canvas, by the ⊕ on an edge, and by the toolbar.
 *
 * It is positioned at a SCREEN point rather than anchored to a trigger element,
 * because three of those four gestures have no element to anchor to (a drop
 * point, a handle that unmounts, an edge midpoint under a transformed SVG). So
 * this is a plain fixed-position panel with its own click-away backdrop rather
 * than a Radix Popover, which would need a virtual anchor for each case.
 *
 * Filtering lives in `searchNodeCatalog` (pure, vitest-covered) — including the
 * handle rules that decide which types a given gesture may offer at all.
 */
export function NodePicker({
  at,
  filter,
  title,
  onPick,
  onClose,
}: {
  /** Viewport coordinates to open near. Clamped to stay fully on screen. */
  at: { x: number; y: number };
  filter?: NodeSearchFilter;
  title?: string;
  onPick: (nodeType: NodeType) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = React.useState("");
  // The highlight carries the query it was chosen under, so typing resets it to
  // the top without an effect — a setState in an effect is a cascading render
  // and this codebase's lint rejects it (same reason the Run-now dialog resets
  // by remounting on a `key` rather than in an effect).
  const [highlight, setHighlight] = React.useState({ query: "", index: 0 });
  const panelRef = React.useRef<HTMLDivElement>(null);

  const groups = React.useMemo(() => searchNodeCatalog(query, filter), [filter, query]);
  const flat = React.useMemo(() => groups.flatMap((group) => group.entries), [groups]);

  // A narrowed list can be shorter than the highlight; clamp rather than letting
  // Enter pick nothing.
  const activeIndex = highlight.query === query ? highlight.index : 0;
  const active = flat.length === 0 ? -1 : Math.min(activeIndex, flat.length - 1);
  const setActiveIndex = React.useCallback((index: number) => setHighlight({ query, index }), [query]);

  const position = usePanelPosition(at, panelRef);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex(((active < 0 ? 0 : active) + delta + flat.length) % flat.length);
      return;
    }
    if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      onPick(flat[active].type);
    }
  };

  return (
    <>
      {/* Click-away. Transparent rather than dimmed: the picker is a small
          inline gesture on the canvas, not a modal moment. */}
      <div className="fixed inset-0 z-40" onPointerDown={onClose} aria-hidden />

      <div
        ref={panelRef}
        role="dialog"
        aria-label={title ?? "Add a node"}
        style={{ left: position.x, top: position.y }}
        onKeyDown={onKeyDown}
        className="fixed z-50 flex max-h-[26rem] w-80 flex-col overflow-hidden rounded-2xl bg-popover shadow-pop"
      >
        <div className="flex items-center gap-2 px-3 py-2.5">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            // The picker mounts in response to a deliberate gesture and is the
            // only thing on screen that takes typing, so it takes focus.
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={title ?? "Search nodes…"}
            aria-label="Search nodes"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="h-px bg-border" />

        {flat.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No node matches “{query.trim()}”.
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {groups.map((group) => (
              <section key={group.category}>
                <h4 className="px-1.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.category}
                </h4>
                {group.entries.map((entry) => {
                  const index = flat.indexOf(entry);
                  const Icon = entry.icon;
                  return (
                    <button
                      key={entry.type}
                      type="button"
                      // Pointer-down, not click: the backdrop above also listens
                      // on pointer-down and would close the panel first.
                      onPointerDown={(event) => {
                        event.preventDefault();
                        onPick(entry.type);
                      }}
                      onMouseEnter={() => setActiveIndex(index)}
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-xl px-1.5 py-2 text-left transition-colors",
                        // NOT `bg-surface-2`: in dark, --surface-2, --popover and
                        // --accent are all #1E1E1E, so an inset fill on a popover
                        // surface is invisible — the same collision that makes a
                        // Card inside a Card disappear. A foreground overlay reads
                        // in both themes, and is what builder.css already uses for
                        // the canvas selection rectangle.
                        index === active ? "bg-foreground/8" : "hover:bg-foreground/8",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-px flex size-7 shrink-0 items-center justify-center rounded-lg",
                          entry.accent,
                        )}
                      >
                        <Icon className="size-3.5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium leading-tight">{entry.label}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                          {entry.description}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

const PANEL_MARGIN = 12;

/**
 * Keep the panel on screen. Measured after mount rather than assumed, because
 * the panel's height depends on how many types the filter left.
 */
function usePanelPosition(at: { x: number; y: number }, ref: React.RefObject<HTMLDivElement | null>) {
  const [position, setPosition] = React.useState(at);

  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      x: clamp(at.x, PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN),
      y: clamp(at.y, PANEL_MARGIN, window.innerHeight - height - PANEL_MARGIN),
    });
  }, [at, ref]);

  return position;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
