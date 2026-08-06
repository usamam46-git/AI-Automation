"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup } from "@/components/workflow-builder/config-field";
import { SchemaBuilder } from "@/components/workflow-builder/schema-builder";
import { StringListEditor } from "@/components/workflow-builder/string-list-editor";

/**
 * Inline agent config, matching `_agent_config` in
 * apps/api/src/graphs/node_handlers.py exactly. `agent_id` is accepted and
 * ignored by the handler, so it is deliberately not surfaced here.
 */
export function AgentConfigForm({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const systemPrompt = typeof config.system_prompt === "string" ? config.system_prompt : "";
  const model = typeof config.model === "string" ? config.model : "";
  const inputFields = Array.isArray(config.input_fields) ? (config.input_fields as string[]) : ["trigger_payload"];
  const outputSchema = (config.output_schema ?? { type: "object", properties: {} }) as Record<string, unknown>;

  function patch(next: Record<string, unknown>) {
    onChange({ ...config, ...next });
  }

  return (
    <div className="flex flex-col gap-5">
      <FieldGroup title="Prompt">
        <Field
          label="System prompt"
          htmlFor="agent-system-prompt"
          required
          error={systemPrompt.trim() ? null : "Required — the node fails at run time without it."}
        >
          <Textarea
            id="agent-system-prompt"
            rows={6}
            value={systemPrompt}
            placeholder="You extract invoice fields from the supplied document text."
            onChange={(event) => patch({ system_prompt: event.target.value })}
            className="text-xs"
          />
        </Field>

        <Field
          label="Input fields"
          hint="Dotted state paths. Only these are passed to the model — smaller prompts, less distraction. Defaults to trigger_payload."
        >
          <StringListEditor
            value={inputFields}
            onChange={(next) => patch({ input_fields: next.length > 0 ? next : ["trigger_payload"] })}
            placeholder="node_outputs.extract.vendor"
            addLabel="Add field"
          />
        </Field>
      </FieldGroup>

      <FieldGroup title="Output schema">
        <Field label="Properties" required hint="Structured output is mandatory — free-text responses are never parsed.">
          <SchemaBuilder value={outputSchema} onChange={(next) => patch({ output_schema: next })} />
        </Field>
      </FieldGroup>

      <FieldGroup title="Model">
        <Field label="Model" htmlFor="agent-model" hint="Leave blank to use the server default.">
          <Input
            id="agent-model"
            value={model}
            placeholder="server default"
            onChange={(event) => patch({ model: event.target.value.trim() === "" ? undefined : event.target.value })}
            className="h-8 font-mono text-xs"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Temperature"
            id="agent-temperature"
            value={config.temperature}
            fallback={0}
            step="0.1"
            min={0}
            max={2}
            onCommit={(next) => patch({ temperature: next ?? 0 })}
          />
          <NumberField
            label="Max tokens"
            id="agent-max-tokens"
            value={config.max_tokens}
            fallback={null}
            step="1"
            min={1}
            placeholder="unlimited"
            onCommit={(next) => patch({ max_tokens: next })}
          />
        </div>
      </FieldGroup>
    </div>
  );
}

/**
 * Numeric input over local text state — binding a number field straight to
 * parsed config eats intermediate values like "0." and "1e".
 */
function NumberField({
  label,
  id,
  value,
  fallback,
  step,
  min,
  max,
  placeholder,
  onCommit,
}: {
  label: string;
  id: string;
  value: unknown;
  fallback: number | null;
  step: string;
  min?: number;
  max?: number;
  placeholder?: string;
  onCommit: (next: number | null) => void;
}) {
  const [text, setText] = React.useState(() => (typeof value === "number" ? String(value) : ""));

  function handleChange(next: string) {
    setText(next);
    if (next.trim() === "") {
      onCommit(fallback);
      return;
    }
    const parsed = Number(next);
    if (Number.isFinite(parsed)) onCommit(parsed);
  }

  return (
    <Field label={label} htmlFor={id}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={text}
        placeholder={placeholder}
        onChange={(event) => handleChange(event.target.value)}
        className="h-8 text-xs"
      />
    </Field>
  );
}
