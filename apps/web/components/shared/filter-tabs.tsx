"use client";

import { cn } from "@/lib/utils";

/**
 * The segmented status filter above a list.
 *
 * Extracted during the Atomie pass. The exact markup was pasted into three
 * pages — Workflows, Executions and Tools — with the Executions copy having
 * already drifted (`whitespace-nowrap`, and its own relabelling of
 * `waiting_approval`). Three copies of a control is three places to restyle and
 * two of them get missed.
 *
 * Not `components/ui/tabs.tsx`: that primitive is Radix `Tabs`, which owns panel
 * association and roving focus for tab PANELS. This filters a list that stays
 * mounted — it is a group of buttons, and modelling it as tabs would promise
 * `aria-controls` semantics nothing here implements.
 */
export function FilterTabs<T extends string>({
  options,
  value,
  onChange,
  label,
  renderLabel,
  className,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  /** Accessible name for the group, e.g. "Filter by status". */
  label: string;
  /** Display text for an option. Defaults to the raw value. */
  renderLabel?: (option: T) => string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("flex w-full gap-1 overflow-x-auto rounded-xl bg-surface-2 p-1 sm:w-fit", className)}>
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option)}
            className={cn(
              "whitespace-nowrap rounded-lg px-3 py-1.5 text-sm capitalize transition-colors",
              // The active segment is the page paper, one step lighter than the
              // track — the same fill-difference depth a Card uses, so it needs
              // neither a shadow nor a border to read as raised.
              active ? "bg-background font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {renderLabel ? renderLabel(option) : option}
          </button>
        );
      })}
    </div>
  );
}
