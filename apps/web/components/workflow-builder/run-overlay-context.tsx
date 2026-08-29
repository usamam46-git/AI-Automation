"use client";

import * as React from "react";
import type { NodeRun, RunOverlay } from "@/lib/run-overlay";

/**
 * The live run, delivered to node cards and edges by context.
 *
 * Same reasoning as `IssueContext` and `BuilderActionsContext`: node `data` is
 * the persisted config and the autosave payload, so run state must never travel
 * through it — a status pill in a saved graph would be a corrupt version.
 */
const RunOverlayContext = React.createContext<RunOverlay | null>(null);

export function RunOverlayProvider({
  overlay,
  children,
}: {
  overlay: RunOverlay | null;
  children: React.ReactNode;
}) {
  return <RunOverlayContext.Provider value={overlay}>{children}</RunOverlayContext.Provider>;
}

export function useRunOverlay(): RunOverlay | null {
  return React.useContext(RunOverlayContext);
}

export function useNodeRun(nodeKey: string): NodeRun | null {
  const overlay = React.useContext(RunOverlayContext);
  return overlay?.nodes.get(nodeKey) ?? null;
}
