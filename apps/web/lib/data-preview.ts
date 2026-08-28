/**
 * lib/data-preview.ts — turning one JSON value into the three views the node
 * detail panels offer: a Table, a JSON tree, and a Schema tree.
 *
 * Pure. Every node carries the **dotted state path** that addresses it, because
 * that path is the thing the builder actually produces: it is what goes into an
 * agent's `input_fields`, a tool's `body_fields`/`payload_fields`/`query_fields`
 * and an edge's `condition.field`, and it is what a drag from the input panel
 * writes.
 *
 * Path construction mirrors `resolve_field_path` in
 * `apps/api/src/graphs/condition_eval.py` exactly, and the two rules that matter
 * are both easy to get wrong:
 *
 * - **Arrays are addressed by integer index** (`hits.0.content`), and negative
 *   indices count from the end. So an array child's path segment is its index,
 *   not a bracket.
 * - **A key containing a dot is UNREACHABLE.** The resolver splits the path on
 *   ".", so `{"a.b": 1}` can never be addressed. Such nodes are marked
 *   `addressable: false` so the UI can refuse to offer them rather than handing
 *   someone a path that silently resolves to null at run time.
 */

export type JsonKind = "string" | "number" | "boolean" | "null" | "object" | "array";

export type PreviewNode = {
  /** Object key, or the array index as a string. */
  key: string;
  /** Full dotted state path, e.g. `node_outputs.policy_lookup.hits.0.score`. */
  path: string;
  kind: JsonKind;
  /** The raw value, for rendering and for deciding what a drop should write. */
  value: unknown;
  /** False when some segment of `path` contains a dot and cannot be resolved. */
  addressable: boolean;
  children: PreviewNode[];
};

/**
 * How deep to walk. Six levels is past anything these graphs produce, and it
 * bounds the tree for a pathological payload rather than trusting the data.
 */
const MAX_DEPTH = 6;

/** How many array items to expand in the tree. The rest are summarised. */
export const ARRAY_PREVIEW_LIMIT = 5;

export function jsonKind(value: unknown): JsonKind {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : (typeof value as JsonKind);
}

/**
 * The immediate children of `value`, each with its full path.
 *
 * A scalar has none — the caller renders it directly. `rootPath` is the path of
 * `value` itself (`trigger_payload`, `node_outputs.extract_invoice`), so the
 * children come out as `${rootPath}.${key}`.
 */
export function describeValue(value: unknown, rootPath: string, depth = 0, parentAddressable = true): PreviewNode[] {
  if (depth >= MAX_DEPTH) return [];

  if (Array.isArray(value)) {
    return value
      .slice(0, ARRAY_PREVIEW_LIMIT)
      .map((item, index) => buildNode(String(index), item, rootPath, depth, parentAddressable));
  }

  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(([key, item]) =>
      buildNode(key, item, rootPath, depth, parentAddressable),
    );
  }

  return [];
}

function buildNode(
  key: string,
  value: unknown,
  parentPath: string,
  depth: number,
  parentAddressable: boolean,
): PreviewNode {
  const path = parentPath ? `${parentPath}.${key}` : key;
  // Unaddressability is INHERITED: a perfectly good key underneath a key that
  // contains a dot is still unreachable, because the resolver splits the whole
  // path on "." and never recovers the intended boundary.
  const addressable = parentAddressable && !key.includes(".");
  return {
    key,
    path,
    kind: jsonKind(value),
    value,
    addressable,
    children: describeValue(value, path, depth + 1, addressable),
  };
}

/** One-line rendering of a scalar for a tree row or a table cell. */
export function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[ ${value.length} ${value.length === 1 ? "item" : "items"} ]`;
  return `{ ${Object.keys(value as object).length} ${Object.keys(value as object).length === 1 ? "key" : "keys"} }`;
}

export type PreviewTable = { columns: string[]; rows: Record<string, unknown>[] };

/**
 * The Table view.
 *
 * An array of objects is the interesting case (retrieval hits, a list-shaped
 * REST body) and becomes one row per item over the union of their keys — union,
 * not the first row's keys, or a field only some items carry would vanish. A
 * plain object is a single row, which is what most node outputs are. Anything
 * else returns null and the caller falls back to the JSON view; a bare scalar
 * has no useful tabular form and faking one ("value: 4200") is noise.
 */
export function toTable(value: unknown): PreviewTable | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return { columns: [], rows: [] };
    if (!value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) return null;

    const rows = value as Record<string, unknown>[];
    const columns: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
    }
    return { columns, rows };
  }

  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return { columns: Object.keys(row), rows: [row] };
  }

  return null;
}

/** Stable, readable JSON for the JSON view. */
export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    // Not expected from an API response, but a cyclic or non-serialisable value
    // must not blank the whole panel.
    return String(value);
  }
}

/** Count of addressable leaves, for the panel's "12 fields" summary line. */
export function countFields(nodes: readonly PreviewNode[]): number {
  return nodes.reduce(
    (total, node) => total + (node.children.length === 0 ? 1 : countFields(node.children)),
    0,
  );
}
