/**
 * lib/state-path.ts — checking a dotted state path against the graph it lives in.
 *
 * Until now the only path checking anywhere in the product was a client-side
 * look at the FIRST SEGMENT against a hardcoded list. Everything past that was
 * unverified, in both languages: nothing checks that `node_outputs.<key>` names
 * a node that exists, and nothing checks that the node is UPSTREAM. The failure
 * is total silence — `resolve_field_path` returns null for any miss, so the
 * agent is handed `{"node_outputs.typo": null}` and reasons over it, or a
 * condition quietly takes its fallback branch. `lib/node-rename.ts` exists
 * because of exactly this class of break.
 *
 * These checks are **advisory, never blocking**. The server stays the authority
 * on what may publish, and a path this file dislikes is still a legal graph — an
 * author part-way through wiring a step should not be stopped by a warning.
 */

/** The roots of `WorkflowState` an author may address. */
export const STATE_ROOTS = [
  "trigger_payload",
  "node_outputs",
  "current_cost_usd",
  "run_id",
  "organization_id",
] as const;

export type StateRoot = (typeof STATE_ROOTS)[number];

export type PathProblem = {
  level: "warning";
  message: string;
};

export type PathContext = {
  /** Every node key on the canvas. */
  nodeKeys: ReadonlySet<string>;
  /** Keys that can actually have run before this node. */
  ancestors: ReadonlySet<string>;
};

/**
 * What is wrong with this path, if anything.
 *
 * Returns at most one problem — the first that applies — because a field showing
 * three stacked warnings about one string is noise, and they are ordered from
 * most to least fundamental.
 */
export function checkStatePath(path: string, context?: PathContext): PathProblem | null {
  const trimmed = path.trim();
  if (trimmed === "") return null;

  const segments = trimmed.split(".");
  const root = segments[0];

  if (!STATE_ROOTS.includes(root as StateRoot)) {
    return {
      level: "warning",
      message: `"${root}" is not a state root, so this resolves to null at run time. Roots: ${STATE_ROOTS.join(", ")}.`,
    };
  }

  if (root !== "node_outputs") return null;

  const nodeKey = segments[1];
  if (!nodeKey) {
    return { level: "warning", message: "node_outputs needs a step key after it, e.g. node_outputs.extract.vendor." };
  }

  // Without graph context there is nothing further that can be said honestly.
  if (!context) return null;

  if (!context.nodeKeys.has(nodeKey)) {
    return { level: "warning", message: `No step named "${nodeKey}" is on this canvas.` };
  }

  if (!context.ancestors.has(nodeKey)) {
    // The single most valuable check here: a forward reference is syntactically
    // perfect, resolves to null every run, and is reported by nothing else.
    return {
      level: "warning",
      message: `"${nodeKey}" does not run before this step, so its output is not available here.`,
    };
  }

  return null;
}

/**
 * Every node that can have run before `nodeKey` — a reverse walk over the edges.
 *
 * Bounded by the visited set, so a cyclic draft (which the canvas holds all the
 * time before publish) terminates instead of spinning.
 */
export function ancestorsOf(
  nodeKey: string,
  edges: readonly { source: string; target: string }[],
): Set<string> {
  const ancestors = new Set<string>();
  const queue = [nodeKey];

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    for (const edge of edges) {
      if (edge.target !== current || ancestors.has(edge.source)) continue;
      ancestors.add(edge.source);
      queue.push(edge.source);
    }
  }

  return ancestors;
}
