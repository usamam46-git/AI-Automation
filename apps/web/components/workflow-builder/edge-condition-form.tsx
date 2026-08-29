"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfigNote, Field, FieldGroup } from "@/components/workflow-builder/config-field";
import { PathInput } from "@/components/workflow-builder/ndv/path-input";
import type { ConditionOperator } from "@/lib/api";

/**
 * Condition editing lives on the EDGE, not on the condition node — condition
 * rows never reach node_handlers.py at all, they compile into routing functions.
 *
 * Operators are exactly SUPPORTED_OPERATORS in
 * apps/api/src/graphs/condition_eval.py. `branch` is a routing label for
 * LangGraph path maps and is not evaluated.
 */
const OPERATORS: Array<{ value: ConditionOperator; label: string }> = [
  { value: "eq", label: "equals" },
  { value: "neq", label: "does not equal" },
  { value: "gt", label: "greater than" },
  { value: "gte", label: "greater than or equal" },
  { value: "lt", label: "less than" },
  { value: "lte", label: "less than or equal" },
  { value: "in", label: "is one of" },
  { value: "contains", label: "contains" },
];

export function EdgeConditionForm({
  condition,
  onChange,
  sourceIsCondition,
  idPrefix = "edge",
}: {
  condition: Record<string, unknown> | null;
  onChange: (next: Record<string, unknown> | null) => void;
  sourceIsCondition: boolean;
  /** Unique per instance. The condition node's rules table renders one of these
   *  per outgoing branch, and duplicate DOM ids would point every label at the
   *  first branch's inputs. */
  idPrefix?: string;
}) {
  const field = typeof condition?.field === "string" ? condition.field : "";
  const operator = (typeof condition?.operator === "string" ? condition.operator : "eq") as ConditionOperator;
  const branch = typeof condition?.branch === "string" ? condition.branch : "";

  function patch(next: Record<string, unknown>) {
    onChange({ field, operator, value: condition?.value ?? null, branch: branch || null, ...next });
  }

  if (!sourceIsCondition) {
    return (
      <ConfigNote>
        This edge always runs. Only edges leaving a Condition node carry a rule — give the condition node its branches and
        the rule fields appear here.
      </ConfigNote>
    );
  }

  return (
    <FieldGroup title="Branch rule">
      {/* Path checking, the picker and drop handling all live in PathInput —
          including the two things the old first-segment check could not say:
          whether the step exists, and whether it runs before this one. */}
      <Field label="Field" htmlFor={`${idPrefix}-field`} hint="Drag a field from the Input panel, or pick one.">
        <PathInput
          id={`${idPrefix}-field`}
          value={field}
          placeholder="node_outputs.extract.confidence"
          onChange={(next) => patch({ field: next })}
        />
      </Field>

      <Field label="Operator">
        <Select value={operator} onValueChange={(next) => patch({ operator: next })}>
          <SelectTrigger className="h-8 text-xs" aria-label="Operator">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPERATORS.map((item) => (
              <SelectItem key={item.value} value={item.value} className="text-xs">
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <ValueField
        idPrefix={idPrefix}
        value={condition?.value}
        operator={operator}
        onCommit={(next) => patch({ value: next })}
      />

      <Field label="Branch label" htmlFor={`${idPrefix}-branch`} hint="A routing label for readability. Not evaluated.">
        <Input
          id={`${idPrefix}-branch`}
          value={branch}
          placeholder="high_confidence"
          onChange={(event) => patch({ branch: event.target.value || null })}
          className="h-8 font-mono text-xs"
        />
      </Field>

      {condition ? (
        <Button type="button" variant="outline" size="sm" className="h-8 self-start text-xs" onClick={() => onChange(null)}>
          Clear rule (always run)
        </Button>
      ) : null}
    </FieldGroup>
  );
}

/**
 * Values are typed JSON — `0.8` must compare as a number, not the string "0.8".
 * Text that does not parse as JSON is stored as a plain string, which is what an
 * author typing `approved` means.
 */
function ValueField({
  value,
  operator,
  onCommit,
  idPrefix,
}: {
  value: unknown;
  operator: ConditionOperator;
  onCommit: (next: unknown) => void;
  idPrefix: string;
}) {
  const [text, setText] = React.useState(() => (value === undefined || value === null ? "" : JSON.stringify(value)));

  function handleChange(next: string) {
    setText(next);
    if (next.trim() === "") {
      onCommit(null);
      return;
    }
    try {
      onCommit(JSON.parse(next));
    } catch {
      onCommit(next);
    }
  }

  let parsed: unknown = null;
  try {
    parsed = text.trim() === "" ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }

  const needsArray = operator === "in";
  const error = needsArray && !Array.isArray(parsed) ? 'The "is one of" operator needs a JSON array, e.g. ["draft", "review"].' : null;

  return (
    <Field
      label="Value"
      htmlFor={`${idPrefix}-value`}
      error={error}
      hint={`Typed as ${describe(parsed)}. Quote it to force a string — 0.8 is a number, "0.8" is text.`}
    >
      <Input
        id={`${idPrefix}-value`}
        value={text}
        placeholder="0.8"
        onChange={(event) => handleChange(event.target.value)}
        className="h-8 font-mono text-xs"
      />
    </Field>
  );
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
