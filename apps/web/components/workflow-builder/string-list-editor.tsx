"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PathInput } from "@/components/workflow-builder/ndv/path-input";
import { FIELD_DRAG_MIME, parseFieldDrag } from "@/lib/field-drag";
import { cn } from "@/lib/utils";

/** Ordered list of strings — agent `input_fields` (dotted state paths). */
export function StringListEditor({
  value,
  onChange,
  placeholder,
  addLabel = "Add",
  itemsArePaths = false,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  addLabel?: string;
  /** Rows hold dotted state paths — give them drop, pick and check. */
  itemsArePaths?: boolean;
}) {
  const [rows, setRows] = React.useState<Array<{ id: number; text: string }>>(() =>
    (value ?? []).map((text, index) => ({ id: index, text })),
  );
  const nextId = React.useRef(rows.length);
  const [dropActive, setDropActive] = React.useState(false);

  function commit(nextRows: typeof rows) {
    setRows(nextRows);
    onChange(nextRows.map((row) => row.text.trim()).filter(Boolean));
  }

  /** A duplicate path is a no-op: `input_fields` is keyed by the path itself
   *  when the user message is built, so adding one twice changes nothing. */
  function appendPath(path: string) {
    if (rows.some((row) => row.text.trim() === path)) return;
    nextId.current += 1;
    commit([...rows, { id: nextId.current, text: path }]);
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-xl transition-colors",
        dropActive && "ring-2 ring-lime ring-offset-4 ring-offset-background",
      )}
      onDragOver={
        itemsArePaths
          ? (event) => {
              if (!event.dataTransfer.types.includes(FIELD_DRAG_MIME)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDropActive(true);
            }
          : undefined
      }
      onDragLeave={itemsArePaths ? () => setDropActive(false) : undefined}
      onDrop={
        itemsArePaths
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
          {itemsArePaths ? (
            <div className="min-w-0 flex-1">
              <PathInput
                ariaLabel={`Item ${index + 1}`}
                value={row.text}
                placeholder={placeholder}
                onChange={(next) => commit(rows.map((item) => (item.id === row.id ? { ...item, text: next } : item)))}
              />
            </div>
          ) : (
            <Input
              aria-label={`Item ${index + 1}`}
              value={row.text}
              placeholder={placeholder}
              onChange={(event) => commit(rows.map((item) => (item.id === row.id ? { ...item, text: event.target.value } : item)))}
              className="h-8 flex-1 font-mono text-xs"
            />
          )}
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
