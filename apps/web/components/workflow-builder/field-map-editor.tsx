"use client";

import { KeyValueEditor } from "@/components/workflow-builder/key-value-editor";
import { STATE_ROOTS } from "@/lib/state-path";

/**
 * Editor for a `{destination_key: "dotted.state.path"}` map — the only way state
 * values reach an outbound request (`body_fields` / `payload_fields` /
 * `query_fields` / `params_fields` / `url_fields`). The URL itself is static;
 * there is no interpolation.
 *
 * Paths resolve against the run's LangGraph state with the same
 * `resolve_field_path` the condition DSL uses, so these roots are exactly the
 * ones an edge condition can address.
 *
 * The per-path checking that used to live here — a look at the first segment
 * against a hardcoded list — moved into `PathInput`, which can say considerably
 * more: it also knows whether the step named actually exists and whether it runs
 * BEFORE this one. `STATE_ROOTS` itself moved to `lib/state-path.ts` so the pure
 * check and the component that renders it do not each own a copy.
 */
export { STATE_ROOTS };

export function FieldMapEditor({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <KeyValueEditor
        value={value}
        onChange={onChange}
        keyPlaceholder="destination key"
        valuePlaceholder="node_outputs.extract.vendor"
        addLabel="Add mapping"
        valueIsPath
      />
      <p className="text-[11px] leading-snug text-muted-foreground">
        Drag a field from the Input panel, or use the field picker. Roots: {STATE_ROOTS.join(", ")}.
      </p>
    </div>
  );
}
