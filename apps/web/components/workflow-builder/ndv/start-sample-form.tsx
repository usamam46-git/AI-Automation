"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup } from "@/components/workflow-builder/config-field";
import { SAMPLE_PAYLOAD_KEY } from "@/lib/node-output-shape";
import { formatTriggerPayload, parseTriggerPayload } from "@/lib/trigger-payload";

/**
 * A sample of the payload this workflow is triggered with.
 *
 * `config.sample_payload` is **ignored by the backend** — node `config` is
 * free-form JSONB with no `extra="forbid"`, and `start_handler` returns `{}`
 * without reading it. It exists so the builder can show, and let you drag from,
 * the fields every downstream node will address as `trigger_payload.*`. Without
 * it a new workflow's field paths have to be typed from memory, which is the
 * single thing this whole redesign is meant to remove.
 *
 * It is stored on the node rather than in `localStorage` so it travels with the
 * version and the team, and parsing reuses `lib/trigger-payload.ts` so the rules
 * are identical to the Run-now dialog's: blank means `{}`, and the top level
 * must be an object because a bare array or scalar is a 422 at the API.
 */
export function StartSampleForm({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const stored = config[SAMPLE_PAYLOAD_KEY];
  const [text, setText] = React.useState(() =>
    stored === undefined || stored === null ? "" : JSON.stringify(stored, null, 2),
  );

  const parsed = parseTriggerPayload(text);

  function commit(next: string) {
    setText(next);
    const result = parseTriggerPayload(next);
    if (!result.ok) return;

    // An empty sample is stored as absence, not as `{}` — otherwise the output
    // panel would claim the trigger delivers an object with no fields rather
    // than saying nothing has been described yet.
    if (next.trim() === "") {
      const rest = { ...config };
      delete rest[SAMPLE_PAYLOAD_KEY];
      onChange(rest);
      return;
    }
    onChange({ ...config, [SAMPLE_PAYLOAD_KEY]: result.value });
  }

  return (
    <FieldGroup title="Sample trigger payload">
      <Field
        label="Example input"
        htmlFor="start-sample"
        error={parsed.ok ? null : parsed.error}
        hint="Saved with the workflow and never sent anywhere. It only tells the builder which trigger_payload fields exist, so downstream steps can reference them."
      >
        <Textarea
          id="start-sample"
          value={text}
          rows={12}
          spellCheck={false}
          placeholder={'{\n  "invoice": {\n    "vendor": "Acme Vendor LLC",\n    "total": 4200\n  }\n}'}
          onChange={(event) => commit(event.target.value)}
          className="font-mono text-xs"
        />
      </Field>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 self-start text-xs"
        disabled={!parsed.ok || text.trim() === ""}
        onClick={() => setText(formatTriggerPayload(text))}
      >
        Format
      </Button>
    </FieldGroup>
  );
}
