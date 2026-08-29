/**
 * lib/condition-rules.ts — the branch rules leaving a condition node, in the
 * order the ENGINE will evaluate them.
 *
 * Mirrors `_ordered_condition_edges` in `apps/api/src/graphs/compiler.py` and
 * `has_predicate` in `apps/api/src/graphs/condition_eval.py`. Routing is
 * first-match-wins, so display order that disagrees with evaluation order is
 * worse than no order at all.
 *
 * **The ordering guarantee is narrower than it looks, and the UI has to say so.**
 * The backend sorts by `(is_catch_all, created_at, id)`. `save_draft` re-inserts
 * every edge of the graph in ONE transaction, so `created_at` is identical
 * across all of them and the tiebreak falls through to `id` — a random UUID.
 * The consequence:
 *
 * - **A catch-all always runs last.** That part is guaranteed, and it is the one
 *   that matters most: a fallback sorting first would make every predicate
 *   behind it dead code and silently route around a human-approval gate. That
 *   was a real bug, fixed 2026-08-22.
 * - **Two predicated branches have NO guaranteed order relative to each other**,
 *   and the order can change on any save. So the classic switch ladder —
 *   `amount > 1000` then `amount > 100` — is not safe here: both match 5000 and
 *   which one wins is arbitrary. Mutually exclusive predicates are.
 *
 * `overlapRisk` exists to surface exactly that, because nothing else does.
 */

export type RuleCondition = Record<string, unknown> | null;

export type ConditionEdgeLike = {
  id: string;
  source: string;
  target: string;
  data?: { condition?: RuleCondition } | null;
};

/**
 * Does this rule actually test anything?
 *
 * Mirrors `has_predicate`: a condition needs BOTH `field` and `operator`. Null,
 * `{}` and a branch-label-only condition all match every state — which is why
 * `evaluate_condition` returns True for them and why they are sorted last.
 */
export function hasPredicate(condition: RuleCondition): boolean {
  if (!condition) return false;
  return typeof condition.field === "string" && condition.field !== "" && typeof condition.operator === "string";
}

/** Evaluation order: predicated branches first (stable), catch-alls last. */
export function orderConditionEdges<T extends ConditionEdgeLike>(edges: readonly T[]): T[] {
  const predicated = edges.filter((edge) => hasPredicate(edge.data?.condition ?? null));
  const catchAll = edges.filter((edge) => !hasPredicate(edge.data?.condition ?? null));
  return [...predicated, ...catchAll];
}

/**
 * True when this condition node has more than one predicated branch, so
 * first-match-wins is deciding between rules whose relative order the engine
 * does not guarantee.
 */
export function overlapRisk(edges: readonly ConditionEdgeLike[]): boolean {
  return edges.filter((edge) => hasPredicate(edge.data?.condition ?? null)).length > 1;
}

/** Human-readable summary of one rule, for the branch's header row. */
export function describeRule(condition: RuleCondition): string {
  if (!hasPredicate(condition)) return "always runs";
  const field = String(condition!.field);
  const leaf = field.split(".").pop() || field;
  const operator = String(condition!.operator);
  return `${leaf} ${operator} ${JSON.stringify(condition!.value ?? null)}`;
}

/** The branch label, or null. Not evaluated — it is a routing label only. */
export function branchLabel(condition: RuleCondition): string | null {
  const label = condition?.branch;
  return typeof label === "string" && label !== "" ? label : null;
}
