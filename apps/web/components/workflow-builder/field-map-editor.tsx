"use client";

import * as React from "react";
import { KeyValueEditor } from "@/components/workflow-builder/key-value-editor";

/**
 * Editor for a `{destination_key: "dotted.state.path"}` map — the only way state
 * values reach an outbound request (`body_fields` / `payload_fields`). The URL
 * itself is static; there is no interpolation.
 *
 * Paths resolve against the run's LangGraph state with the same
 * `resolve_field_path` the condition DSL uses, so these roots are exactly the
 * ones an edge condition can address.
 */
export const STATE_ROOTS = ["trigger_payload", "node_outputs", "current_cost_usd", "run_id", "organization_id"] as const;

export function FieldMapEditor({ value, onChange }: { value: Record<string, string>; onChange: (next: Record<string, string>) => void }) {
  const unknownRoots = Object.values(value ?? {})
    .map((path) => path.split(".")[0])
    .filter((root) => root && !STATE_ROOTS.includes(root as (typeof STATE_ROOTS)[number]));

  return (
    <div className="flex flex-col gap-1.5">
      <KeyValueEditor
        value={value}
        onChange={onChange}
        keyPlaceholder="destination key"
        valuePlaceholder="node_outputs.extract.vendor"
        addLabel="Add mapping"
      />
      {unknownRoots.length > 0 ? (
        <p className="text-[11px] leading-snug text-status-warn">
          {`"${unknownRoots[0]}" is not a state root, so this path will resolve to null at run time. Roots: ${STATE_ROOTS.join(", ")}.`}
        </p>
      ) : null}
    </div>
  );
}
