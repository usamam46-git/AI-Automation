import { Flag, GitBranch, Play, Sparkles, UserCheck, Workflow, Wrench, type LucideIcon } from "lucide-react";
import type { NodeType } from "@/lib/api";

/**
 * Groups in the node picker, in the order they are offered. Deliberately shaped
 * around what a step DOES rather than around the `NodeType` enum: someone adding
 * a step is looking for "call an API", not for "a node of type tool".
 */
export const NODE_CATEGORIES = ["Trigger", "AI", "Actions", "Flow"] as const;
export type NodeCategory = (typeof NODE_CATEGORIES)[number];

export type NodeCatalogEntry = {
  type: NodeType;
  label: string;
  /** One-line description shown in the palette and the config panel header. */
  description: string;
  icon: LucideIcon;
  category: NodeCategory;
  /** Extra search terms for the picker — the words someone types when they do
   *  not know this product's vocabulary yet ("if", "api", "gpt"). Matched as
   *  substrings alongside the label and description. */
  keywords: string[];
  /** Tint for the node's icon chip. Kept to icon + chip only — node bodies stay
   *  neutral card surfaces so the canvas reads as one system in both themes.
   *
   *  Since the Atomie pass these are `--color-status-*` classes plus the brand
   *  `.app-tile`, not raw Tailwind palette pairs with hand-written `dark:`
   *  twins. Two consequences worth knowing: a theme change is one token edit
   *  rather than seven, and the tints now MEAN the same thing they mean on a
   *  Badge — `human_approval` is warn because a run holding at a gate is warn
   *  in the timeline and on the dashboard too.
   *
   *  `agent` carries the brand tile deliberately: it is the only node type that
   *  reasons, it is what the product is for, and it is the one place lime
   *  appears on the canvas. */
  accent: string;
  /** Prefix for auto-incremented node keys (`agent_1`, `tool_2`, ...). */
  keyPrefix: string;
  hasSource: boolean;
  hasTarget: boolean;
  /** Blank `config` for a freshly dropped node. Types with no handler config
   *  at all (start/end/condition/human_approval) deliberately produce `{}`. */
  blankConfig: () => Record<string, unknown>;
};

export const NODE_CATALOG: Record<NodeType, NodeCatalogEntry> = {
  start: {
    type: "start",
    label: "Start",
    description: "Entry point. Receives the trigger payload.",
    icon: Play,
    category: "Trigger",
    keywords: ["trigger", "begin", "entry", "webhook", "schedule", "cron", "input"],
    accent: "bg-status-ok-soft text-status-ok",
    keyPrefix: "start",
    hasSource: true,
    hasTarget: false,
    blankConfig: () => ({}),
  },
  agent: {
    type: "agent",
    label: "Agent",
    description: "Calls the LLM with a system prompt and a structured output schema.",
    icon: Sparkles,
    category: "AI",
    keywords: ["llm", "gpt", "openai", "model", "prompt", "extract", "classify", "summarise", "summarize", "reason"],
    accent: "app-tile",
    keyPrefix: "agent",
    hasSource: true,
    hasTarget: true,
    // Inline config — the agents module is models-only, so `agent_id` resolves
    // to nothing and is ignored by the handler. See apps/api/CLAUDE.md.
    blankConfig: () => ({
      system_prompt: "",
      output_schema: { type: "object", properties: {} },
      input_fields: ["trigger_payload"],
    }),
  },
  tool: {
    type: "tool",
    label: "Tool",
    description: "Outbound HTTP request or ERP connector action.",
    icon: Wrench,
    category: "Actions",
    keywords: ["http", "api", "request", "call", "erp", "knowledge", "search", "rag", "retrieve", "notify", "slack", "webhook", "post"],
    accent: "bg-status-info-soft text-status-info",
    keyPrefix: "tool",
    hasSource: true,
    hasTarget: true,
    // `is_mutating` must stay a real JSON boolean — a string is rejected at
    // invoke time and would silently bypass the publish-time approval gate.
    blankConfig: () => ({ tool_type: "http_request", is_mutating: false, method: "GET", url: "" }),
  },
  condition: {
    type: "condition",
    label: "Condition",
    description: "Routes to different branches. The rule lives on its outgoing edges.",
    icon: GitBranch,
    category: "Flow",
    keywords: ["if", "else", "switch", "branch", "route", "filter", "when"],
    accent: "bg-status-warn-soft text-status-warn",
    keyPrefix: "condition",
    hasSource: true,
    hasTarget: true,
    blankConfig: () => ({}),
  },
  human_approval: {
    type: "human_approval",
    label: "Human Approval",
    description: "Pauses the run until someone approves or rejects.",
    icon: UserCheck,
    category: "Flow",
    keywords: ["approve", "approval", "review", "gate", "pause", "wait", "human", "sign off"],
    accent: "bg-status-warn-soft text-status-warn",
    keyPrefix: "approval",
    hasSource: true,
    hasTarget: true,
    blankConfig: () => ({}),
  },
  subgraph: {
    type: "subgraph",
    label: "Subgraph",
    description: "Runs another workflow. Not executable yet.",
    icon: Workflow,
    category: "Actions",
    keywords: ["nested", "child", "call workflow", "reuse"],
    accent: "bg-status-info-soft text-status-info",
    keyPrefix: "subgraph",
    hasSource: true,
    hasTarget: true,
    blankConfig: () => ({ workflow_id: "" }),
  },
  end: {
    type: "end",
    label: "End",
    description: "Terminal node. The run completes here.",
    icon: Flag,
    category: "Flow",
    keywords: ["finish", "stop", "complete", "done", "output"],
    accent: "bg-surface-2 text-muted-foreground",
    keyPrefix: "end",
    hasSource: false,
    hasTarget: true,
    blankConfig: () => ({}),
  },
};

/** Palette order — start/end bracket the list the way they bracket a graph. */
export const PALETTE_ORDER: NodeType[] = ["start", "agent", "tool", "condition", "human_approval", "subgraph", "end"];

export type NodeCatalogGroup = { category: NodeCategory; entries: NodeCatalogEntry[] };

export type NodeSearchFilter = {
  /** Only offer nodes that can be connected TO (they have an input handle). */
  needsTarget?: boolean;
  /** Only offer nodes that can be connected FROM (they have an output handle). */
  needsSource?: boolean;
};

/**
 * Grouped, filtered catalog for the node picker.
 *
 * The handle filters are not cosmetic. Adding a step off another node's output
 * has to exclude `start` — it has no input handle, so the edge the gesture
 * promises cannot exist — and inserting into an existing edge additionally
 * excludes `end`. Offering a node the gesture cannot connect would leave a
 * freshly added orphan on the canvas and an `orphan` validation error the user
 * did not ask for.
 *
 * Every term must match (AND, not OR), so "http tool" narrows rather than
 * widens. Matching is substring over label + description + keywords + type, so
 * "if" finds Condition and "gpt" finds Agent.
 *
 * Results are RANKED, and the ranking is not decoration. Plain substring
 * matching put Agent above Condition for the query "if" — because "classify"
 * contains it — which makes the search look like it is guessing. An exact
 * keyword hit now beats an accidental substring, and the groups themselves are
 * ordered by their best match, so the category someone meant comes first.
 * A blank query scores everything equally and the sort is stable, so the
 * documented category order survives untouched.
 */
export function searchNodeCatalog(query: string, filter: NodeSearchFilter = {}): NodeCatalogGroup[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored = PALETTE_ORDER.map((nodeType) => NODE_CATALOG[nodeType])
    .filter((entry) => {
      if (filter.needsTarget && !entry.hasTarget) return false;
      if (filter.needsSource && !entry.hasSource) return false;
      return true;
    })
    .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
    .filter((candidate) => candidate.score !== NO_MATCH);

  return NODE_CATEGORIES.map((category) => {
    const inCategory = scored
      .filter((candidate) => candidate.entry.category === category)
      .sort((a, b) => a.score - b.score);
    return {
      category,
      entries: inCategory.map((candidate) => candidate.entry),
      best: inCategory.length === 0 ? NO_MATCH : inCategory[0].score,
    };
  })
    .filter((group) => group.entries.length > 0)
    .sort((a, b) => a.best - b.best)
    .map(({ category, entries }) => ({ category, entries }));
}

const NO_MATCH = Number.POSITIVE_INFINITY;

/** Sum of each term's best hit. Lower is better; `NO_MATCH` if any term misses. */
function scoreEntry(entry: NodeCatalogEntry, terms: readonly string[]): number {
  let total = 0;
  for (const term of terms) {
    const hit = scoreTerm(entry, term);
    if (hit === NO_MATCH) return NO_MATCH;
    total += hit;
  }
  return total;
}

function scoreTerm(entry: NodeCatalogEntry, term: string): number {
  const label = entry.label.toLowerCase();
  const keywords = entry.keywords.map((keyword) => keyword.toLowerCase());

  if (label === term) return 0;
  if (label.startsWith(term)) return 1;
  if (keywords.includes(term)) return 2;
  if (label.includes(term)) return 3;
  if (keywords.some((keyword) => keyword.includes(term))) return 4;
  if (entry.type.includes(term) || entry.description.toLowerCase().includes(term)) return 5;
  return NO_MATCH;
}

/**
 * Readable auto-incremented key for a newly dropped node (`agent_1`, `tool_2`).
 * The backend's duplicate-key rejection stays the authority; this only avoids
 * the obvious collision.
 */
export function nextNodeKey(nodeType: NodeType, existingKeys: Iterable<string>): string {
  const prefix = NODE_CATALOG[nodeType].keyPrefix;
  const taken = new Set(existingKeys);
  let index = 1;
  while (taken.has(`${prefix}_${index}`)) index += 1;
  return `${prefix}_${index}`;
}
