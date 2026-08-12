import type { BuilderGraph } from "@/lib/graph-mapping";

/**
 * TypeScript mirror of the backend's graph validation, so the canvas can show
 * precise per-node errors instantly instead of parsing a 422 after the fact.
 *
 * DRIFT RISK — READ BEFORE EDITING. These eight rules are duplicated from
 * apps/api/src/modules/workflows/service.py (`validate_draft_structure`,
 * `validate_graph_structure`, `validate_mutating_approval`,
 * `_resolve_registry_tools`). Change one side and you must change the other. The
 * server's 422 remains the authority; this exists for feedback before publish is
 * ever attempted, never to replace the gate.
 *
 * Two of the rules need the workspace's registry tools, which the caller passes
 * in — see `ToolRegistry` below for what omitting them costs.
 *
 * One deliberate divergence: the backend raises on the *first* failing rule,
 * while this reports every failure at once. That is a superset, so nothing the
 * server would reject passes here.
 */

export type ValidationRule =
  | "duplicate_key"
  | "dangling_edge"
  | "missing_start"
  | "missing_end"
  | "orphan"
  | "cycle"
  | "unguarded_mutating"
  | "unknown_tool";

/**
 * The workspace's registry tools, keyed by id, with each row's `is_mutating`.
 *
 * `undefined` means "not loaded" and is not the same as an empty registry:
 * without it, the two registry-aware rules are skipped entirely and this module
 * behaves exactly as it did before the tools module existed. An *empty* map, by
 * contrast, means every `tool_id` on the graph resolves to nothing.
 */
export type ToolRegistry = ReadonlyMap<string, boolean>;

/**
 * node_key -> tool_id for every **tool** node referencing the registry, mirroring
 * `_referenced_tool_ids`. Node type matters: an `agent` node carrying a stray
 * `tool_id` is not a registry reference on either side.
 */
function referencedToolIds(graph: BuilderGraph): Map<string, string> {
  const referenced = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.data.nodeType !== "tool") continue;
    const raw = node.data.config?.tool_id;
    if (typeof raw !== "string" || !raw) continue;
    referenced.set(node.id, raw);
  }
  return referenced;
}

export type GraphIssue = {
  rule: ValidationRule;
  message: string;
  /** Canvas node keys to highlight. Empty when the issue is about the whole graph. */
  nodeKeys: string[];
};

/** The two data-integrity rules `save_draft` enforces. A draft may be unfinished. */
export function validateDraft(graph: BuilderGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];

  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const node of graph.nodes) {
    if (seen.has(node.id) && !duplicates.includes(node.id)) duplicates.push(node.id);
    seen.add(node.id);
  }
  if (duplicates.length > 0) {
    issues.push({
      rule: "duplicate_key",
      message: `Duplicate node keys: ${duplicates.sort().join(", ")}. Each node key must be unique.`,
      nodeKeys: duplicates,
    });
  }

  const dangling = graph.edges.filter((edge) => !seen.has(edge.source) || !seen.has(edge.target));
  if (dangling.length > 0) {
    issues.push({
      rule: "dangling_edge",
      message: `${dangling.length} ${dangling.length === 1 ? "edge references" : "edges reference"} a node that no longer exists.`,
      nodeKeys: dangling.flatMap((edge) => [edge.source, edge.target]).filter((key) => seen.has(key)),
    });
  }

  return issues;
}

/** Every rule `publish_version` enforces: the draft rules plus shape and safety. */
export function validateGraph(graph: BuilderGraph, tools?: ToolRegistry): GraphIssue[] {
  const issues = validateDraft(graph);

  const nodeKeys = new Set(graph.nodes.map((node) => node.id));
  // Shape rules are only meaningful over edges that actually resolve; dangling
  // ones are already reported above and would otherwise produce phantom orphans.
  const edges = graph.edges.filter((edge) => nodeKeys.has(edge.source) && nodeKeys.has(edge.target));

  if (graph.nodes.length === 0) return issues;

  const startKeys = graph.nodes.filter((node) => node.data.nodeType === "start").map((node) => node.id);
  const endKeys = graph.nodes.filter((node) => node.data.nodeType === "end").map((node) => node.id);

  if (startKeys.length === 0) {
    issues.push({ rule: "missing_start", message: "The graph needs at least one start node.", nodeKeys: [] });
  }
  if (endKeys.length === 0) {
    issues.push({ rule: "missing_end", message: "The graph needs at least one end node.", nodeKeys: [] });
  }

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const key of nodeKeys) {
    incoming.set(key, 0);
    outgoing.set(key, 0);
  }
  for (const edge of edges) {
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }

  const orphans = graph.nodes
    .filter((node) => {
      const missingIncoming = node.data.nodeType !== "start" && (incoming.get(node.id) ?? 0) === 0;
      const missingOutgoing = node.data.nodeType !== "end" && (outgoing.get(node.id) ?? 0) === 0;
      return missingIncoming || missingOutgoing;
    })
    .map((node) => node.id);
  if (orphans.length > 0) {
    issues.push({
      rule: "orphan",
      message: `Not connected: ${orphans.slice().sort().join(", ")}. Every node needs an incoming edge (unless it is a start) and an outgoing edge (unless it is an end).`,
      nodeKeys: orphans,
    });
  }

  const cycle = findCycle(nodeKeys, edges);
  if (cycle) {
    issues.push({
      rule: "cycle",
      message: `Cycle detected: ${cycle.join(" → ")}. Loops are not supported yet.`,
      nodeKeys: Array.from(new Set(cycle)),
    });
  }

  const unresolved = findUnresolvedToolNodes(graph, tools);
  if (unresolved.length > 0) {
    issues.push({
      rule: "unknown_tool",
      message: `${unresolved.join(", ")} point${unresolved.length === 1 ? "s" : ""} at a tool that is no longer in the registry. Pick another tool, or switch the node to inline configuration.`,
      nodeKeys: unresolved,
    });
  }

  const unguarded = findUnguardedMutatingNodes(graph, tools);
  if (unguarded.length > 0) {
    issues.push({
      rule: "unguarded_mutating",
      message: `${unguarded.join(", ")} write${unguarded.length === 1 ? "s" : ""} to an external system but ${unguarded.length === 1 ? "has" : "have"} no human approval step upstream. Add a Human Approval node somewhere before ${unguarded.length === 1 ? "it" : "them"}.`,
      nodeKeys: unguarded,
    });
  }

  return issues;
}

/**
 * Mirrors the FK-validation half of `_resolve_registry_tools`: a `tool_id` that
 * resolves to nothing — deleted, another org's, or never existed — fails the
 * publish with a 422 naming the node.
 *
 * Nodes carrying inline `tool_type` are exempt, exactly as on the server: inline
 * config is the supported non-registry path, and a stray forward-compat
 * `tool_id` beside it is a documented no-op rather than a broken reference.
 *
 * One knowing divergence: the server's `_referenced_tool_ids` silently drops a
 * `tool_id` that is not a well-formed UUID, so a malformed one is not reported
 * at publish. It is reported here, because a lookup miss and a malformed id
 * leave the node equally broken — `_tool_config` raises on both at invoke time —
 * and the picker cannot produce either, so this only ever fires on hand-edited
 * or stale config.
 */
function findUnresolvedToolNodes(graph: BuilderGraph, tools?: ToolRegistry): string[] {
  if (!tools) return [];

  const unresolved: string[] = [];
  for (const [nodeKey, toolId] of referencedToolIds(graph)) {
    const node = graph.nodes.find((item) => item.id === nodeKey);
    if (node?.data.config?.tool_type) continue;
    if (!tools.has(toolId)) unresolved.push(nodeKey);
  }
  return unresolved.sort();
}

function findCycle(nodeKeys: Set<string>, edges: BuilderGraph["edges"]): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const key of nodeKeys) adjacency.set(key, []);
  for (const edge of edges) adjacency.get(edge.source)?.push(edge.target);

  const UNVISITED = 0;
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  for (const key of nodeKeys) state.set(key, UNVISITED);

  function dfs(node: string, stack: string[]): string[] | null {
    state.set(node, VISITING);
    stack.push(node);
    for (const neighbour of adjacency.get(node) ?? []) {
      if (state.get(neighbour) === UNVISITED) {
        const cycle = dfs(neighbour, stack);
        if (cycle) return cycle;
      } else if (state.get(neighbour) === VISITING) {
        return [...stack.slice(stack.indexOf(neighbour)), neighbour];
      }
    }
    stack.pop();
    state.set(node, DONE);
    return null;
  }

  for (const key of nodeKeys) {
    if (state.get(key) === UNVISITED) {
      const cycle = dfs(key, []);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * ∃-semantics, matching `validate_mutating_approval` exactly: a mutating node is
 * flagged only when *zero* human_approval nodes exist anywhere in its ancestor
 * set — not when some individual path to it skips one. ∀ would reject the
 * blueprint's own Vol. 5 §1 and §5 workflows, which both route straight to the
 * journal-entry write on their clean branch. Do not "tighten" this to ∀ without
 * changing the backend first.
 *
 * A node counts as mutating if EITHER source says so — its own literal
 * `is_mutating: true`, or a registry tool it references whose row is mutating.
 * A node may **upgrade** but never **downgrade**: `is_mutating: false` on a node
 * pointing at a mutating registry tool is still mutating, or the gate would be
 * one keystroke away from being switched off. Note this half applies even to a
 * node that also carries inline `tool_type` — unlike the FK check above, the
 * server does not exempt those, and the conservative reading is the safe one.
 *
 * Until the registry was threaded in (2026-08-12) this read `is_mutating` only
 * and therefore **under-reported** every registry-backed mutating node, leaving
 * them to surface as a 422 at publish.
 */
function findUnguardedMutatingNodes(graph: BuilderGraph, tools?: ToolRegistry): string[] {
  const mutatingToolNodes = tools ? new Set(Array.from(referencedToolIds(graph)).filter(([, toolId]) => tools.get(toolId) === true).map(([nodeKey]) => nodeKey)) : new Set<string>();

  const mutatingKeys = graph.nodes
    .filter((node) => node.data.config?.is_mutating === true || mutatingToolNodes.has(node.id))
    .map((node) => node.id);
  if (mutatingKeys.length === 0) return [];

  const approvalKeys = new Set(graph.nodes.filter((node) => node.data.nodeType === "human_approval").map((node) => node.id));

  const ancestorsOf = new Map<string, string[]>();
  for (const node of graph.nodes) ancestorsOf.set(node.id, []);
  for (const edge of graph.edges) ancestorsOf.get(edge.target)?.push(edge.source);

  const unguarded: string[] = [];
  for (const mutatingKey of mutatingKeys) {
    const seen = new Set<string>();
    const queue = [...(ancestorsOf.get(mutatingKey) ?? [])];
    let approved = false;
    while (queue.length > 0) {
      const current = queue.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      if (approvalKeys.has(current)) {
        approved = true;
        break;
      }
      queue.push(...(ancestorsOf.get(current) ?? []));
    }
    if (!approved) unguarded.push(mutatingKey);
  }
  return unguarded.sort();
}

/**
 * Turn a 422 `detail` into something attributable to nodes on the canvas.
 *
 * Only the dangling-edge case is structured; every other rule returns a string
 * with a Python-repr list embedded, so keys are recovered by scanning for
 * quoted tokens (and for the `a -> b -> a` cycle path) and cross-referencing
 * against real canvas keys. Anything unattributable keeps its message and gets
 * an empty `nodeKeys`, so the caller can surface it as a banner rather than
 * dropping it.
 */
export function parseValidationDetail(detail: unknown, knownKeys: Set<string>): GraphIssue {
  if (detail && typeof detail === "object" && "invalid_edges" in detail) {
    const record = detail as { message?: string; invalid_edges?: Array<{ source_node_key?: string; target_node_key?: string }> };
    const keys = (record.invalid_edges ?? [])
      .flatMap((edge) => [edge.source_node_key, edge.target_node_key])
      .filter((key): key is string => typeof key === "string" && knownKeys.has(key));
    return {
      rule: "dangling_edge",
      message: record.message ?? "Edges reference nodes that do not exist.",
      nodeKeys: Array.from(new Set(keys)),
    };
  }

  const message = typeof detail === "string" ? detail : JSON.stringify(detail);
  const quoted = Array.from(message.matchAll(/'([^']+)'/g), (match) => match[1]);
  const cycleParts = message.includes(" -> ") ? message.split(":").pop()?.split("->").map((part) => part.trim()) ?? [] : [];
  const nodeKeys = Array.from(new Set([...quoted, ...cycleParts])).filter((key) => knownKeys.has(key));

  return { rule: ruleFromMessage(message), message, nodeKeys };
}

function ruleFromMessage(message: string): ValidationRule {
  if (message.startsWith("Duplicate node_key")) return "duplicate_key";
  if (message.startsWith("Orphan nodes")) return "orphan";
  if (message.startsWith("Cycle detected")) return "cycle";
  if (message.startsWith("Mutating nodes")) return "unguarded_mutating";
  if (message.startsWith("Tool nodes reference tools that do not exist")) return "unknown_tool";
  if (message.includes("start node")) return "missing_start";
  if (message.includes("end node")) return "missing_end";
  return "dangling_edge";
}
