import type { Edge, Node } from "@xyflow/react";
import type { EdgeInput, NodeInput, NodeType, WorkflowVersion } from "@/lib/api";

/**
 * Pure translation between the API's `WorkflowVersionResponse` shape and the
 * React Flow arrays the canvas renders.
 *
 * Identity rule (settled): the React Flow node `id` **is** `node_key`.
 * `NodeResponse.id` UUIDs are regenerated on every draft save — `save_draft`
 * replaces the whole row set — so they are unstable and unusable as canvas ids.
 * `EdgeInput` already references nodes by key, so edges map 1:1 with no
 * translation.
 */

export type BuilderNodeData = {
  nodeKey: string;
  nodeType: NodeType;
  config: Record<string, unknown>;
};

export type BuilderNode = Node<BuilderNodeData, NodeType>;

export type BuilderEdgeData = {
  condition: Record<string, unknown> | null;
};

export type BuilderEdge = Edge<BuilderEdgeData>;

export type BuilderGraph = {
  nodes: BuilderNode[];
  edges: BuilderEdge[];
};

export const EMPTY_GRAPH: BuilderGraph = { nodes: [], edges: [] };

/** Edge ids are derived, not persisted — backend edge UUIDs churn like node ones. */
export function edgeId(sourceNodeKey: string, targetNodeKey: string): string {
  return `${sourceNodeKey}->${targetNodeKey}`;
}

export function versionToFlow(version: WorkflowVersion | null | undefined): BuilderGraph {
  if (!version) return { nodes: [], edges: [] };

  return {
    nodes: version.nodes.map((node) => ({
      id: node.node_key,
      type: node.node_type,
      position: { x: node.position_x ?? 0, y: node.position_y ?? 0 },
      data: {
        nodeKey: node.node_key,
        nodeType: node.node_type,
        config: node.config ?? {},
      },
    })),
    edges: version.edges.map((edge) => ({
      id: edgeId(edge.source_node_key, edge.target_node_key),
      source: edge.source_node_key,
      target: edge.target_node_key,
      data: { condition: edge.condition },
    })),
  };
}

/**
 * Order-independent fingerprint of a save payload, used to decide whether the
 * canvas differs from what the server last stored. Sorted deliberately: the
 * server returns rows in its own order, so an unsorted stringify would read a
 * freshly loaded graph as already dirty.
 */
export function graphSignature(payload: { nodes: NodeInput[]; edges: EdgeInput[] }): string {
  return JSON.stringify({
    nodes: [...payload.nodes].sort((a, b) => a.node_key.localeCompare(b.node_key)),
    edges: [...payload.edges].sort((a, b) =>
      `${a.source_node_key}->${a.target_node_key}`.localeCompare(`${b.source_node_key}->${b.target_node_key}`),
    ),
  });
}

export function flowToVersion(graph: BuilderGraph): { nodes: NodeInput[]; edges: EdgeInput[] } {
  return {
    nodes: graph.nodes.map((node) => ({
      node_key: node.data.nodeKey,
      node_type: node.data.nodeType,
      config: node.data.config ?? {},
      // Whole pixels: React Flow positions are fractional and would otherwise
      // make every drag produce a different autosave payload.
      position_x: Math.round(node.position.x),
      position_y: Math.round(node.position.y),
    })),
    edges: graph.edges.map((edge) => ({
      source_node_key: edge.source,
      target_node_key: edge.target,
      condition: edge.data?.condition ?? null,
    })),
  };
}
