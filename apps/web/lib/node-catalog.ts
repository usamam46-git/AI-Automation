import { Flag, GitBranch, Play, Sparkles, UserCheck, Workflow, Wrench, type LucideIcon } from "lucide-react";
import type { NodeType } from "@/lib/api";

export type NodeCatalogEntry = {
  type: NodeType;
  label: string;
  /** One-line description shown in the palette and the config panel header. */
  description: string;
  icon: LucideIcon;
  /** Tint for the node's icon chip. Kept to icon + chip only — node bodies stay
   *  neutral card surfaces so the canvas reads as one system in both themes. */
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
    accent: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
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
    accent: "text-violet-600 dark:text-violet-400 bg-violet-500/10",
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
    accent: "text-sky-600 dark:text-sky-400 bg-sky-500/10",
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
    accent: "text-amber-600 dark:text-amber-400 bg-amber-500/10",
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
    accent: "text-rose-600 dark:text-rose-400 bg-rose-500/10",
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
    accent: "text-teal-600 dark:text-teal-400 bg-teal-500/10",
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
    accent: "text-neutral-600 dark:text-neutral-300 bg-neutral-500/10",
    keyPrefix: "end",
    hasSource: false,
    hasTarget: true,
    blankConfig: () => ({}),
  },
};

/** Palette order — start/end bracket the list the way they bracket a graph. */
export const PALETTE_ORDER: NodeType[] = ["start", "agent", "tool", "condition", "human_approval", "subgraph", "end"];

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
