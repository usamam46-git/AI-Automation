import { edgeId, type BuilderGraph } from "@/lib/graph-mapping";

/**
 * Renaming a node key on the canvas.
 *
 * A node key is not cosmetic — it is the node's identity everywhere: the React
 * Flow node `id` (see graph-mapping.ts's identity rule), both ends of every
 * edge, and the second segment of every `node_outputs.<key>.<field>` state path
 * an author has typed into a config or an edge condition. A rename that moved
 * only the node would leave every downstream mapping pointing at a key that no
 * longer exists — the one class of error nothing catches until run time, since
 * a path with a valid root but a dead second segment resolves to nothing rather
 * than failing validation.
 *
 * So the rename is a whole-graph rewrite, and it is pure: the caller hands it a
 * graph and gets a new one back, which is what makes it testable without a
 * canvas.
 */

/** Mirrors the auto-generated `<prefix>_<n>` shape from `nextNodeKey()`. */
export const NODE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** The state path prefix under which a node's own output is addressed. */
const OUTPUT_ROOT = "node_outputs";

/**
 * Why a candidate key is unusable, or null when it is fine. `currentKey` is
 * excluded from the collision check so re-committing an unchanged key is not an
 * error.
 */
export function validateNodeKey(candidate: string, currentKey: string, existingKeys: Iterable<string>): string | null {
  const key = candidate.trim();
  if (key.length === 0) return "A node key is required.";
  if (key.length > 64) return "A node key is at most 64 characters.";
  if (!NODE_KEY_PATTERN.test(key)) {
    return "Use lowercase letters, digits and underscores, starting with a letter.";
  }
  for (const existing of existingKeys) {
    if (existing !== currentKey && existing === key) return `Another node already uses ${key}.`;
  }
  return null;
}

/**
 * Retarget one dotted state path. Only `node_outputs.<oldKey>` matches, and only
 * on a segment boundary — `node_outputs.agent_1` must not rewrite the prefix of
 * `node_outputs.agent_10`, and a field that happens to be named after the node
 * (`node_outputs.other.agent_1`) is not a reference to it.
 */
export function retargetStatePath(path: string, oldKey: string, newKey: string): string {
  const segments = path.split(".");
  if (segments.length < 2 || segments[0] !== OUTPUT_ROOT || segments[1] !== oldKey) return path;
  segments[1] = newKey;
  return segments.join(".");
}

/**
 * Deep-rewrite every state path inside an arbitrary config value. Configs are
 * free-form JSON — `input_fields` is an array of paths, the field-map editors
 * store paths as object values, and an edge condition keeps one under `field` —
 * so this walks the whole structure rather than knowing any single shape.
 */
export function rewriteStatePaths<T>(value: T, oldKey: string, newKey: string): T {
  if (typeof value === "string") return retargetStatePath(value, oldKey, newKey) as T;
  if (Array.isArray(value)) return value.map((item) => rewriteStatePaths(item, oldKey, newKey)) as T;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      rewriteStatePaths(item, oldKey, newKey),
    ]);
    return Object.fromEntries(entries) as T;
  }
  return value;
}

/**
 * Rename a node across the whole graph: the node itself, both ends of every
 * edge touching it (edge ids are derived from the pair, so they are rebuilt),
 * and every `node_outputs.<oldKey>` path in any node config or edge condition.
 *
 * Returns the graph unchanged when the key is unchanged. The caller is expected
 * to have run `validateNodeKey` first; an unknown `oldKey` is a no-op.
 */
export function renameNodeKey(graph: BuilderGraph, oldKey: string, newKey: string): BuilderGraph {
  if (oldKey === newKey) return graph;
  if (!graph.nodes.some((node) => node.id === oldKey)) return graph;

  return {
    nodes: graph.nodes.map((node) => {
      const config = rewriteStatePaths(node.data.config ?? {}, oldKey, newKey);
      if (node.id !== oldKey) return { ...node, data: { ...node.data, config } };
      return { ...node, id: newKey, data: { ...node.data, nodeKey: newKey, config } };
    }),
    edges: graph.edges.map((edge) => {
      const source = edge.source === oldKey ? newKey : edge.source;
      const target = edge.target === oldKey ? newKey : edge.target;
      const condition = edge.data?.condition ? rewriteStatePaths(edge.data.condition, oldKey, newKey) : (edge.data?.condition ?? null);
      return { ...edge, id: edgeId(source, target), source, target, data: { ...edge.data, condition } };
    }),
  };
}
