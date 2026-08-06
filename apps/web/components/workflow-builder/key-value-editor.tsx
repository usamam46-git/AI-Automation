"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
}) {
  const [rows, setRows] = React.useState<Array<{ id: number; key: string; value: string }>>(() =>
    Object.entries(value ?? {}).map(([key, entryValue], index) => ({ id: index, key, value: String(entryValue) })),
  );
  const nextId = React.useRef(rows.length);

  function commit(nextRows: typeof rows) {
    setRows(nextRows);
    const next: Record<string, string> = {};
    for (const row of nextRows) {
      if (row.key.trim()) next[row.key.trim()] = row.value;
    }
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row, index) => (
        <div key={row.id} className="flex items-center gap-1.5">
          <Input
            aria-label={`${keyPlaceholder} ${index + 1}`}
            value={row.key}
            placeholder={keyPlaceholder}
            onChange={(event) => commit(rows.map((item) => (item.id === row.id ? { ...item, key: event.target.value } : item)))}
            className="h-8 flex-1 text-xs"
          />
          <Input
            aria-label={`${valuePlaceholder} ${index + 1}`}
            value={row.value}
            placeholder={valuePlaceholder}
            onChange={(event) => commit(rows.map((item) => (item.id === row.id ? { ...item, value: event.target.value } : item)))}
            className="h-8 flex-1 text-xs"
          />
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
