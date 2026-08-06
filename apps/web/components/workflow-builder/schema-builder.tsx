"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useWorkflowBuilderStore } from "@/stores/workflow-builder-store";
import { fieldsToSchema, schemaToFields, SCALAR_TYPES, type OutputSchema, type ScalarType, type SchemaField } from "@/lib/output-schema";
import { cn } from "@/lib/utils";

/**
 * Editor for an agent node's `output_schema`. The emit/parse rules live in
 * lib/output-schema.ts — read that file's header before changing anything here.
 *
 * There is deliberately no "required" toggle: strict mode makes every declared
 * property required, so optionality is expressed as a nullable type
 * (`{"type": ["string", "null"]}`). That is what the Nullable switch produces.
 */

export function SchemaBuilder({ value, onChange }: { value: Record<string, unknown>; onChange: (next: OutputSchema) => void }) {
  const mode = useWorkflowBuilderStore((state) => state.schemaEditorMode);
  const setMode = useWorkflowBuilderStore((state) => state.setSchemaEditorMode);

  // Anything with nesting, arrays, combinators or $defs is beyond what field
  // rows can express — those schemas are JSON-only rather than silently flattened.
  const parsed = React.useMemo(() => schemaToFields(value), [value]);
  const representable = parsed !== null;
  const effectiveMode = representable ? mode : "json";

  const properties = (value?.properties ?? {}) as Record<string, unknown>;
  const isEmpty = Object.keys(properties).length === 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Tabs value={effectiveMode} onValueChange={(next) => setMode(next as "fields" | "json")}>
          <TabsList className="h-7">
            <TabsTrigger value="fields" className="h-6 px-2 text-xs" disabled={!representable}>
              Fields
            </TabsTrigger>
            <TabsTrigger value="json" className="h-6 px-2 text-xs">
              JSON
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {effectiveMode === "fields" ? (
        <FieldRows fields={parsed ?? []} onChange={(fields) => onChange(fieldsToSchema(fields))} />
      ) : (
        <RawSchemaEditor value={value} onChange={onChange} />
      )}

      {!representable ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          This schema uses nesting, arrays or combinators, which the field builder cannot represent. Edit it as JSON.
        </p>
      ) : null}

      {isEmpty ? (
        <p className="text-[11px] leading-snug text-destructive">
          Add at least one property — the agent node is rejected at run time with an empty schema.
        </p>
      ) : null}
    </div>
  );
}

function FieldRows({ fields, onChange }: { fields: SchemaField[]; onChange: (fields: SchemaField[]) => void }) {
  const [rows, setRows] = React.useState<SchemaField[]>(fields);
  const nextId = React.useRef(fields.length);

  function commit(next: SchemaField[]) {
    setRows(next);
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-1.5">
      {rows.length > 0 ? (
        <div className="grid grid-cols-[1fr_7rem_auto_2rem] items-center gap-1.5 px-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          <span>Property</span>
          <span>Type</span>
          <span>Nullable</span>
          <span />
        </div>
      ) : null}

      {rows.map((row, index) => (
        <div key={row.id} className="grid grid-cols-[1fr_7rem_auto_2rem] items-center gap-1.5">
          <Input
            aria-label={`Property name ${index + 1}`}
            value={row.name}
            placeholder="confidence"
            onChange={(event) => commit(rows.map((item) => (item.id === row.id ? { ...item, name: event.target.value } : item)))}
            className="h-8 font-mono text-xs"
          />
          <Select
            value={row.type}
            onValueChange={(next) => commit(rows.map((item) => (item.id === row.id ? { ...item, type: next as ScalarType } : item)))}
          >
            <SelectTrigger className="h-8 text-xs" aria-label={`Type of property ${index + 1}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCALAR_TYPES.map((type) => (
                <SelectItem key={type} value={type} className="text-xs">
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex justify-center px-2">
            <Switch
              size="sm"
              aria-label={`Property ${index + 1} nullable`}
              checked={row.nullable}
              onCheckedChange={(checked) => commit(rows.map((item) => (item.id === row.id ? { ...item, nullable: checked } : item)))}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove property ${index + 1}`}
            className="size-8 text-muted-foreground hover:text-destructive"
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
          commit([...rows, { id: nextId.current, name: "", type: "string", nullable: false }]);
        }}
      >
        <Plus className="size-3.5" />
        Add property
      </Button>
    </div>
  );
}

function RawSchemaEditor({ value, onChange }: { value: Record<string, unknown>; onChange: (next: OutputSchema) => void }) {
  const [text, setText] = React.useState(() => JSON.stringify(value ?? { type: "object", properties: {} }, null, 2));
  const [error, setError] = React.useState<string | null>(null);

  function handleChange(next: string) {
    setText(next);
    try {
      const parsed = JSON.parse(next);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError("Must be a JSON Schema object.");
        return;
      }
      const record = parsed as Record<string, unknown>;
      if (record.required || record.additionalProperties !== undefined) {
        setError("Remove 'required' / 'additionalProperties' — the server injects both for strict mode.");
        return;
      }
      if (typeof record.properties !== "object" || record.properties === null) {
        setError("Schema needs a 'properties' object.");
        return;
      }
      setError(null);
      onChange({ ...record, type: "object", properties: record.properties as Record<string, unknown> });
    } catch {
      setError("Not valid JSON yet.");
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        value={text}
        rows={10}
        spellCheck={false}
        onChange={(event) => handleChange(event.target.value)}
        className={cn("font-mono text-xs", error && "border-destructive")}
      />
      {error ? <p className="text-[11px] leading-snug text-destructive">{error}</p> : null}
    </div>
  );
}

