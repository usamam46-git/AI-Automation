"use client";

import * as React from "react";
import { Braces, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useFieldSources } from "@/components/workflow-builder/ndv/field-sources-context";
import { FIELD_DRAG_MIME, parseFieldDrag } from "@/lib/field-drag";
import { checkStatePath } from "@/lib/state-path";
import { cn } from "@/lib/utils";

/**
 * An input that holds a dotted state path — and the three ways to fill it in.
 *
 * 1. **Drop** a field dragged out of the input panel.
 * 2. **Pick** it from a searchable list of everything upstream.
 * 3. **Type** it, as before.
 *
 * The picker is not a fallback, it is the primary implementation: drag is a
 * mouse-only gesture, and a builder whose central act is unreachable by keyboard
 * is not finished. Drag simply routes to the same `onChange`.
 *
 * The warning line underneath is the reason this component exists at all. A path
 * with a good root and a wrong node key resolves to null at run time and is
 * reported by absolutely nothing — not the canvas, not publish, not the run.
 */
export function PathInput({
  id,
  value,
  onChange,
  placeholder = "node_outputs.extract.vendor",
  ariaLabel,
  className,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const { options, context } = useFieldSources();
  const [dropActive, setDropActive] = React.useState(false);

  const problem = checkStatePath(value, context);

  return (
    <div className="flex flex-col gap-1">
      <div
        className={cn(
          "flex items-center gap-1 rounded-xl transition-colors",
          dropActive && "ring-2 ring-lime ring-offset-2 ring-offset-background",
        )}
        onDragOver={(event) => {
          // Only claim the drop when it is actually one of ours, or a file drag
          // over the panel would show a drop affordance and then do nothing.
          if (!event.dataTransfer.types.includes(FIELD_DRAG_MIME)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDropActive(true);
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(event) => {
          setDropActive(false);
          const payload = parseFieldDrag(event.dataTransfer.getData(FIELD_DRAG_MIME));
          if (!payload) return;
          event.preventDefault();
          onChange(payload.path);
        }}
      >
        <Input
          id={id}
          value={value}
          aria-label={ariaLabel}
          spellCheck={false}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={cn("h-8 flex-1 font-mono text-xs", className)}
        />
        <PathPicker options={options} onPick={onChange} />
      </div>

      {problem ? (
        <p className="flex gap-1 text-[11px] leading-snug text-status-warn">
          <TriangleAlert className="mt-px size-3 shrink-0" />
          <span>{problem.message}</span>
        </p>
      ) : null}
    </div>
  );
}

/** The keyboard-reachable half of the gesture. */
function PathPicker({
  options,
  onPick,
}: {
  options: ReturnType<typeof useFieldSources>["options"];
  onPick: (path: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const matches = React.useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return options;
    return options.filter((option) => {
      const haystack = `${option.path} ${option.label} ${option.group}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [options, query]);

  const groups = React.useMemo(() => {
    const byGroup = new Map<string, typeof matches>();
    for (const option of matches) {
      const existing = byGroup.get(option.group);
      if (existing) existing.push(option);
      else byGroup.set(option.group, [option]);
    }
    return [...byGroup.entries()];
  }, [matches]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Choose a field"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <Braces className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="p-2">
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search fields…"
            aria-label="Search fields"
            className="h-8 text-xs"
          />
        </div>
        <div className="max-h-64 overflow-y-auto px-1.5 pb-1.5">
          {options.length === 0 ? (
            <p className="px-1.5 py-4 text-center text-[11px] leading-snug text-muted-foreground">
              Nothing upstream produces data yet. Connect a step before this one, or describe the trigger payload on the
              Start step.
            </p>
          ) : groups.length === 0 ? (
            <p className="px-1.5 py-4 text-center text-[11px] text-muted-foreground">No field matches.</p>
          ) : (
            groups.map(([group, items]) => (
              <section key={group}>
                <h4 className="px-1.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {group}
                </h4>
                {items.map((option) => (
                  <button
                    key={option.path}
                    type="button"
                    onClick={() => {
                      onPick(option.path);
                      setOpen(false);
                      setQuery("");
                    }}
                    className="flex w-full items-baseline gap-1.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-foreground/8"
                  >
                    <span className="shrink-0 font-mono text-[11px]">{option.label}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                      {option.path}
                    </span>
                    <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground">
                      {option.kind}
                    </span>
                  </button>
                ))}
              </section>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
