"use client";

import * as React from "react";
import type { GraphIssue } from "@/lib/graph-validation";

/**
 * Validation issues, keyed by node. Delivered by context rather than through
 * node `data` because `data` is the persisted config — a validation result must
 * never end up in an autosave payload.
 */
const IssueContext = React.createContext<Map<string, GraphIssue[]>>(new Map());

export function IssueProvider({ issues, children }: { issues: Map<string, GraphIssue[]>; children: React.ReactNode }) {
  return <IssueContext.Provider value={issues}>{children}</IssueContext.Provider>;
}

export function useNodeIssues(nodeKey: string): GraphIssue[] {
  return React.useContext(IssueContext).get(nodeKey) ?? [];
}

/** Group issues by the nodes they blame. Issues with no attributable node are excluded. */
export function groupIssuesByNode(issues: GraphIssue[]): Map<string, GraphIssue[]> {
  const grouped = new Map<string, GraphIssue[]>();
  for (const issue of issues) {
    for (const nodeKey of issue.nodeKeys) {
      const existing = grouped.get(nodeKey);
      if (existing) existing.push(issue);
      else grouped.set(nodeKey, [issue]);
    }
  }
  return grouped;
}
