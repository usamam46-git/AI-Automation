"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PathInput } from "@/components/workflow-builder/ndv/path-input";
import { applyPathToFieldMap, FIELD_DRAG_MIME, parseFieldDrag } from "@/lib/field-drag";
import { cn } from "@/lib/utils";

/**
 * Editor for a flat string→string map (HTTP headers today).
 *
 * Rows are held in local state rather than derived from the map on every
 * keystroke: a controlled map would drop a row the moment its key is blank or
 * collides with another, which happens constantly while typing.
 */
export function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder = "Name",
  valuePlaceholder = "Value",
  addLabel = "Add row",
  valueIsPath = false,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  /** The value half holds a dotted state path — give it drop, pick and check. */
  valueIsPath?: boolean;
}) {
  const [rows, setRows] = React.useState<Array<{ id: number; key: string; value: string }>>(() =>
    Object.entries(value ?? {}).map(([key, entryValue], index) => ({ id: index, key, value: String(entryValue) })),
  );
  const nextId = React.useRef(rows.length);
  const [dropActive, setDropActive] = React.useState(false);

  /**
   * Dropping a field on the map appends a mapping, with a destination key
   * derived from the path's leaf and de-duplicated against what is already
   * there. Handled HERE rather than in `FieldMapEditor` because the rows are
   * local state — they are read from `value` only on mount, so appending from
   * outside would not appear until the editor remounted.
   */
  function appendPath(path: string) {
    const asMap = Object.fromEntries(
      rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]),
    );
    const { key } = applyPathToFieldMap(asMap, path);
    nextId.current += 1;
    commit([...rows, { id: nextId.current, key, value: path }]);
  }

  function commit(nextRows: typeof rows) {
    setRows(nextRows);
    const next: Record<string, string> = {};
    for (const row of nextRows) {
      if (row.key.trim()) next[row.key.trim()] = row.value;
    }
    onChange(next);
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-xl transition-colors",
        dropActive && "ring-2 ring-lime ring-offset-4 ring-offset-background",
      )}
      onDragOver={
        valueIsPath
          ? (event) => {
              if (!event.dataTransfer.types.includes(FIELD_DRAG_MIME)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDropActive(true);
            }
          : undefined
      }
      onDragLeave={valueIsPath ? () => setDropActive(false) : undefined}
      onDrop={
        valueIsPath
          ? (event) => {
              setDropActive(false);
              const payload = parseFieldDrag(event.dataTransfer.getData(FIELD_DRAG_MIME));
              if (!payload) return;
              event.preventDefault();
              appendPath(payload.path);
            }
          : undefined
      }
    >
      {rows.map((row, index) => (
        <div key={row.id} className="flex items-start gap-1.5">
          <Input
            aria-label={`${keyPlaceholder} ${index + 1}`}
            value={row.key}
            placeholder={keyPlaceholder}
            onChange={(event) => commit(rows.map((item) => (item.id === row.id ? { ...item, key: event.target.value } : item)))}
            className="h-8 flex-1 text-xs"
          />
          {valueIsPath ? (
            <div className="min-w-0 flex-1">
              <PathInput
                ariaLabel={`${valuePlaceholder} ${index + 1}`}
                value={row.value}
                placeholder={valuePlaceholder}
                onChange={(next) => commit(rows.map((item) => (item.id === row.id ? { ...item, value: next } : item)))}
              />
            </div>
          ) : (
            <Input
              aria-label={`${valuePlaceholder} ${index + 1}`}
              value={row.value}
              placeholder={valuePlaceholder}
              onChange={(event) => commit(rows.map((item) => (item.id === row.id ? { ...item, value: event.target.value } : item)))}
              className="h-8 flex-1 text-xs"
            />
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove row ${index + 1}`}
            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => commit(rows.filter((item) => item.id !== row.id))}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 self-start text-xs"
        onClick={() => {
          nextId.current += 1;
          commit([...rows, { id: nextId.current, key: "", value: "" }]);
        }}
      >
        <Plus className="size-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}
