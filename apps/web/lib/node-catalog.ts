import { Flag, GitBranch, Play, Sparkles, UserCheck, Workflow, Wrench, type LucideIcon } from "lucide-react";
import type { NodeType } from "@/lib/api";

export type NodeCatalogEntry = {
  type: NodeType;
  label: string;
  /** One-line description shown in the palette and the config panel header. */
  description: string;
  icon: LucideIcon;
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
    accent: "bg-surface-2 text-muted-foreground",
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
