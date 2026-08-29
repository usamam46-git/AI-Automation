"use client";

import * as React from "react";
import type { JsonKind, PreviewNode } from "@/lib/data-preview";
import type { PathContext } from "@/lib/state-path";

/**
 * Every state path the node being edited may legitimately read, plus the graph
 * context needed to judge a hand-typed one.
 *
 * Delivered by context because the parameter forms are several layers deep
 * (`ToolConfigForm` → `FieldMapEditor` → `KeyValueEditor` → the input itself)
 * and threading two props through all of them would touch every signature for
 * something none of the intermediate layers care about.
 */
export type PathOption = {
  path: string;
  /** Leaf name, shown as the primary label. */
  label: string;
  kind: JsonKind;
  /** Which upstream step this came from, used as the group heading. */
  group: string;
};

export type FieldSources = {
  options: PathOption[];
  /** Undefined when the graph is not known — the checks then stay silent. */
  context: PathContext | undefined;
};

const EMPTY: FieldSources = { options: [], context: undefined };

const FieldSourcesContext = React.createContext<FieldSources>(EMPTY);

export function FieldSourcesProvider({
  sources,
  children,
}: {
  sources: FieldSources;
  children: React.ReactNode;
}) {
  return <FieldSourcesContext.Provider value={sources}>{children}</FieldSourcesContext.Provider>;
}

export function useFieldSources(): FieldSources {
  return React.useContext(FieldSourcesContext);
}

/**
 * Flatten a preview tree into pickable paths.
 *
 * Container nodes are offered as well as leaves — mapping a whole object across
 * (`node_outputs.extract` into an agent's `input_fields`) is exactly what the
 * demo graphs do, so offering only leaves would hide the most common case.
 * Unaddressable nodes are dropped: a path with a dot inside a segment can never
 * resolve, so offering it would be handing someone a guaranteed null.
 */
export function flattenPathOptions(nodes: readonly PreviewNode[], group: string): PathOption[] {
  const options: PathOption[] = [];

  const walk = (items: readonly PreviewNode[]) => {
    for (const item of items) {
      if (!item.addressable) continue;
      options.push({ path: item.path, label: item.key, kind: item.kind, group });
      walk(item.children);
    }
  };

  walk(nodes);
  return options;
}
