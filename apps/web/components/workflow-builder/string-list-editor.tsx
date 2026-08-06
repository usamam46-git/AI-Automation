"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Ordered list of strings — agent `input_fields` (dotted state paths). */
export function StringListEditor({
  value,
  onChange,
  placeholder,
  addLabel = "Add",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  addLabel?: string;
}) {
  const [rows, setRows] = React.useState<Array<{ id: number; text: string }>>(() =>
    (value ?? []).map((text, index) => ({ id: index, text })),
  );
  const nextId = React.useRef(rows.length);

  function commit(nextRows: typeof rows) {
    setRows(nextRows);
    onChange(nextRows.map((row) => row.text.trim()).filter(Boolean));
  }

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row, index) => (
        <div key={row.id} className="flex items-center gap-1.5">
          <Input
            aria-label={`Item ${index + 1}`}
            value={row.text}
            placeholder={placeholder}
            onChange={(event) => commit(rows.map((item) => (item.id === row.id ? { ...item, text: event.target.value } : item)))}
            className="h-8 flex-1 font-mono text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove item ${index + 1}`}
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
          commit([...rows, { id: nextId.current, text: "" }]);
        }}
      >
        <Plus className="size-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}
