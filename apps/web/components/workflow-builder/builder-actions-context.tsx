"use client";

import * as React from "react";

/**
 * Canvas gestures a node card or an edge needs to invoke, delivered by context.
 *
 * Same reasoning as `IssueContext` next door: node `data` is the persisted
 * config and the autosave payload, so a callback must never travel through it.
 * Registering these as props on `nodeTypes` is the other option and is worse —
 * React Flow re-creates every node component when that object's identity
 * changes, so a per-render closure would remount the whole canvas on each edit.
 *
 * `at` is a VIEWPORT point (from the triggering element's own bounding rect),
 * because the picker positions itself in screen space.
 */
export type BuilderActions = {
  /** ⊕ on a node's output handle — add a node and wire this one into it. */
  addAfter: (nodeKey: string, at: { x: number; y: number }) => void;
  /** ⊕ on an edge — drop a node into the middle of that connection. */
  insertOnEdge: (edgeId: string, at: { x: number; y: number }) => void;
  /** ✕ on an edge. */
  deleteEdge: (edgeId: string) => void;
  /** Open the node detail view. Wired in phase 2; selection-only until then. */
  openNode: (nodeKey: string) => void;
};

const NOOP: BuilderActions = {
  addAfter: () => {},
  insertOnEdge: () => {},
  deleteEdge: () => {},
  openNode: () => {},
};

const BuilderActionsContext = React.createContext<BuilderActions>(NOOP);

export function BuilderActionsProvider({
  actions,
  children,
}: {
  actions: BuilderActions;
  children: React.ReactNode;
}) {
  return <BuilderActionsContext.Provider value={actions}>{children}</BuilderActionsContext.Provider>;
}

export function useBuilderActions(): BuilderActions {
  return React.useContext(BuilderActionsContext);
}

/**
 * Node keys that already have at least one outgoing edge.
 *
 * Drives whether a card shows the ⊕ on its output handle, which is n8n's rule:
 * the ⊕ marks an output that is not connected yet. It is not only a convention —
 * it is the only placement that works. The ⊕ sits ~30px outside the card, in the
 * connector's lane, and the seeded demo graphs space nodes 220px apart with a
 * 210px card. On a connected node that lane is INSIDE the next card, which paints
 * over the button (React Flow gives every node wrapper an inline `z-index: 0`, so
 * later siblings win) and takes the hover, so the ⊕ could be neither seen nor
 * clicked. On an unconnected output there is nothing there to cover it.
 *
 * Adding a step between two connected nodes is the edge's own ⊕; adding a second
 * branch off a node is a drag from its handle onto empty canvas.
 */
const OutgoingContext = React.createContext<ReadonlySet<string>>(new Set());

export function NodeOutgoingProvider({
  nodeKeys,
  children,
}: {
  nodeKeys: ReadonlySet<string>;
  children: React.ReactNode;
}) {
  return <OutgoingContext.Provider value={nodeKeys}>{children}</OutgoingContext.Provider>;
}

export function useHasOutgoing(nodeKey: string): boolean {
  return React.useContext(OutgoingContext).has(nodeKey);
}
