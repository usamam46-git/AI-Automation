/**
 * lib/field-drag.ts — dragging a field out of the input panel and into a
 * parameter.
 *
 * **What a drop writes is a dotted state path, never an expression.** n8n drops
 * `{{ $json.foo }}` into a template string; this product deliberately has no
 * template language and no `eval` anywhere — the structured DSL
 * (`input_fields`, the `*_fields` maps, `condition.field`) is the whole
 * addressing surface, and `resolve_field_path` is its one resolver. So a drop
 * fills in a path, and the shapes the config forms emit are byte-identical to
 * what they were before anyone dragged anything.
 *
 * Everything here is pure so the drop RULES are asserted rather than
 * click-tested: the components only decide where a drop landed.
 */

import type { JsonKind } from "@/lib/data-preview";

/** Drag MIME, distinct from the node palette's so the canvas cannot confuse them. */
export const FIELD_DRAG_MIME = "application/x-workflow-field-path";

export type FieldDragPayload = {
  /** The dotted state path, e.g. `node_outputs.extract.vendor_name`. */
  path: string;
  /** Leaf segment, used to suggest a destination key. */
  key: string;
  kind: JsonKind;
};

export function serializeFieldDrag(payload: FieldDragPayload): string {
  return JSON.stringify(payload);
}

/** Never throws: a foreign drag lands here too, and it must simply be ignored. */
export function parseFieldDrag(raw: string | null | undefined): FieldDragPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FieldDragPayload>;
    if (typeof parsed?.path !== "string" || parsed.path.trim() === "") return null;
    return {
      path: parsed.path,
      key: typeof parsed.key === "string" ? parsed.key : lastSegment(parsed.path),
      kind: (parsed.kind ?? "null") as JsonKind,
    };
  } catch {
    return null;
  }
}

/**
 * The destination key a dropped path suggests.
 *
 * The leaf segment, unless the leaf is an array INDEX (`hits.0`) — "0" is a
 * useless field name, so the segment before it is used instead. Anything the
 * backend would not accept as a key is reduced to underscores.
 */
export function destinationKeyFor(path: string): string {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return "value";

  let leaf = segments[segments.length - 1];
  if (/^-?\d+$/.test(leaf) && segments.length > 1) leaf = segments[segments.length - 2];

  const cleaned = leaf.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return cleaned === "" ? "value" : cleaned;
}

/**
 * Add a path to a `{destination_key: path}` map.
 *
 * The suggested key is de-duplicated rather than overwriting, because dropping a
 * second field should never silently replace the first one someone mapped.
 */
export function applyPathToFieldMap(
  map: Record<string, string>,
  path: string,
): { next: Record<string, string>; key: string } {
  const base = destinationKeyFor(path);
  let key = base;
  let suffix = 2;
  while (key in map) {
    key = `${base}_${suffix}`;
    suffix += 1;
  }
  return { next: { ...map, [key]: path }, key };
}

/**
 * Append a path to a list of paths (an agent's `input_fields`).
 *
 * A duplicate is a no-op: `input_fields` is keyed by the path itself when the
 * user message is built, so adding one twice changes nothing except the list's
 * length.
 */
export function applyPathToList(list: readonly string[], path: string): string[] {
  return list.includes(path) ? [...list] : [...list, path];
}

function lastSegment(path: string): string {
  const segments = path.split(".").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}
