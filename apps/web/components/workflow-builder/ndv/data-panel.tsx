"use client";

import * as React from "react";
import { FieldTree } from "@/components/workflow-builder/ndv/field-tree";
import {
  countFields,
  describeValue,
  formatJson,
  formatScalar,
  toTable,
  type PreviewNode,
} from "@/lib/data-preview";
import { cn } from "@/lib/utils";

/**
 * One side panel of the node detail view — INPUT on the left, OUTPUT on the
 * right — in whichever of two states it can be in:
 *
 * - **`value`**: real data from a run. All three views are offered (Table / JSON
 *   / Schema), because there is something to put in them.
 * - **`shape`**: the DECLARED shape, with no run behind it. Only the schema view
 *   exists — a Table of a shape with no values is a header row and nothing else,
 *   and offering an empty JSON view would suggest the run produced `{}` rather
 *   than that it has not happened.
 *
 * That split is why the toggle is conditional rather than always drawn. It is
 * also what lets the panels be useful on a workflow that has never executed,
 * which is exactly when someone needs the guidance most.
 */
export type PanelData =
  | { mode: "value"; value: unknown; rootPath: string }
  | { mode: "shape"; fields: readonly PreviewNode[] };

type ViewMode = "table" | "json" | "schema";

export function DataPanel({
  title,
  subtitle,
  data,
  note,
  emptyLabel,
}: {
  title: string;
  /** Where this data comes from — the source node, or "1 item". */
  subtitle?: React.ReactNode;
  data: PanelData | null;
  /** Shown instead of the tree when there is nothing to render. */
  note?: string | null;
  emptyLabel: string;
}) {
  const [view, setView] = React.useState<ViewMode>("schema");

  const fields = React.useMemo(
    () => (data === null ? [] : data.mode === "shape" ? data.fields : describeValue(data.value, data.rootPath)),
    [data],
  );

  const table = React.useMemo(() => (data?.mode === "value" ? toTable(data.value) : null), [data]);

  const canToggle = data?.mode === "value";
  // A narrowed view can be unavailable (a scalar has no table); fall back rather
  // than rendering a blank panel under a selected tab.
  const effectiveView: ViewMode = !canToggle ? "schema" : view === "table" && table === null ? "json" : view;

  return (
    <section className="flex min-h-0 min-w-0 flex-col">
      <header className="flex min-h-9 shrink-0 items-center gap-2 px-3">
        <h3 className="app-eyebrow shrink-0">{title}</h3>
        {subtitle ? (
          <span className="min-w-0 flex-1 truncate text-[11px] leading-tight text-muted-foreground">{subtitle}</span>
        ) : (
          <span className="flex-1" aria-hidden />
        )}
        {canToggle ? <ViewToggle view={effectiveView} hasTable={table !== null} onChange={setView} /> : null}
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-3 pb-3 pt-1">
        {data === null || (fields.length === 0 && table === null) ? (
          <Placeholder>{note ?? emptyLabel}</Placeholder>
        ) : effectiveView === "table" && table ? (
          <PreviewTableView columns={table.columns} rows={table.rows} />
        ) : effectiveView === "json" && data.mode === "value" ? (
          <pre className="overflow-x-auto rounded-xl bg-surface-2 p-2.5 font-mono text-[11px] leading-relaxed">
            {formatJson(data.value)}
          </pre>
        ) : (
          <>
            <FieldTree nodes={fields} showValues={data.mode === "value"} />
            {note ? <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{note}</p> : null}
          </>
        )}
      </div>

      {fields.length > 0 ? (
        <footer className="shrink-0 px-3 pb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
          {countFields(fields)} {countFields(fields) === 1 ? "field" : "fields"}
        </footer>
      ) : null}
    </section>
  );
}

function ViewToggle({
  view,
  hasTable,
  onChange,
}: {
  view: ViewMode;
  hasTable: boolean;
  onChange: (next: ViewMode) => void;
}) {
  const options: { value: ViewMode; label: string; disabled?: boolean }[] = [
    { value: "table", label: "Table", disabled: !hasTable },
    { value: "json", label: "JSON" },
    { value: "schema", label: "Schema" },
  ];

  return (
    // The segmented-control track is `--surface-2`, which is what that token is
    // for. Safe here because the detail view is a page-level surface, not a
    // popover — on a popover the two collide at #1E1E1E in dark.
    <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
            "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
            option.disabled
              ? "cursor-not-allowed text-muted-foreground/50"
              : view === option.value
                ? "bg-popover text-foreground shadow-soft"
                : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function PreviewTableView({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  if (columns.length === 0) return <Placeholder>No rows.</Placeholder>;

  return (
    // Wide tables scroll inside their own container — the panel must never
    // scroll horizontally as a whole.
    <div className="overflow-x-auto rounded-xl bg-surface-2">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column}
                className="whitespace-nowrap px-2 py-1.5 text-left font-medium text-muted-foreground"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t border-border">
              {columns.map((column) => (
                <td key={column} className="max-w-[18rem] truncate px-2 py-1.5 font-mono">
                  {formatScalar(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border p-3 text-[11px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}
