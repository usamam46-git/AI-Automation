"use client";

import * as React from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Raw JSON object editor for the free-form `body` / `payload` dicts, whose
 * values are arbitrary JSON — a key/value grid would only be able to express
 * strings.
 *
 * The draft text is local so an in-progress edit is never destroyed by a
 * re-render; `onChange` only fires once the text parses to an object.
 */
export function JsonObjectEditor({
  value,
  onChange,
  rows = 4,
  placeholder = '{ "key": "value" }',
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  rows?: number;
  placeholder?: string;
}) {
  const [text, setText] = React.useState(() => serialize(value));
  const [error, setError] = React.useState<string | null>(null);

  function handleChange(next: string) {
    setText(next);
    if (next.trim() === "") {
      setError(null);
      onChange({});
      return;
    }
    try {
      const parsed = JSON.parse(next);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError("Must be a JSON object, not an array or a bare value.");
        return;
      }
      setError(null);
      onChange(parsed as Record<string, unknown>);
    } catch {
      setError("Not valid JSON yet.");
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        value={text}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(event) => handleChange(event.target.value)}
        className={cn("font-mono text-xs", error && "border-destructive")}
      />
      {error ? <p className="text-[11px] leading-snug text-destructive">{error}</p> : null}
    </div>
  );
}

function serialize(value: Record<string, unknown>): string {
  if (!value || Object.keys(value).length === 0) return "";
  return JSON.stringify(value, null, 2);
}
