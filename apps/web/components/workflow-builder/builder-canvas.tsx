"use client";

import * as React from "react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import type { NodeType } from "@/lib/api";
import { edgeId, type BuilderEdge, type BuilderGraph, type BuilderNode } from "@/lib/graph-mapping";
import { NODE_CATALOG, nextNodeKey } from "@/lib/node-catalog";
import { useWorkflowBuilderStore } from "@/stores/workflow-builder-store";
import { NODE_DRAG_MIME, NodePalette } from "@/components/workflow-builder/node-palette";
import { builderNodeTypes } from "@/components/workflow-builder/nodes/builder-node";

import "@xyflow/react/dist/style.css";
import "@/components/workflow-builder/builder.css";

export function BuilderCanvas({
  graph,
  setGraph,
  readOnly = false,
}: {
  graph: BuilderGraph;
  setGraph: (updater: (graph: BuilderGraph) => BuilderGraph) => void;
  readOnly?: boolean;
}) {
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();
  const selectNode = useWorkflowBuilderStore((state) => state.selectNode);
  const selectEdge = useWorkflowBuilderStore((state) => state.selectEdge);
  const selectedEdgeId = useWorkflowBuilderStore((state) => state.selectedEdgeId);

  const onNodesChange = React.useCallback(
    (changes: NodeChange<BuilderNode>[]) => {
      const removed = changes.some((change) => change.type === "remove");
      setGraph((current) => {
        const nodes = applyNodeChanges(changes, current.nodes);
        if (!removed) return { ...current, nodes };
        // Safety net: React Flow's own delete path also emits edge removals,
        // but a node must never survive in the payload as a dangling edge ref.
        const keys = new Set(nodes.map((node) => node.id));
        return { nodes, edges: current.edges.filter((edge) => keys.has(edge.source) && keys.has(edge.target)) };
      });
    },
    [setGraph],
  );

  const onEdgesChange = React.useCallback(
    (changes: EdgeChange<BuilderEdge>[]) => {
      setGraph((current) => ({ ...current, edges: applyEdgeChanges(changes, current.edges) }));
    },
    [setGraph],
  );

  const onConnect = React.useCallback(
    (connection: Connection) => {
      setGraph((current) => ({
        ...current,
        edges: addEdge<BuilderEdge>(
          { ...connection, id: edgeId(connection.source, connection.target), data: { condition: null } },
          current.edges,
        ),
      }));
    },
    [setGraph],
  );

  const addNode = React.useCallback(
    (nodeType: NodeType, position: { x: number; y: number }) => {
      setGraph((current) => {
        const nodeKey = nextNodeKey(nodeType, current.nodes.map((node) => node.id));
        const node: BuilderNode = {
          id: nodeKey,
          type: nodeType,
          position,
          data: { nodeKey, nodeType, config: NODE_CATALOG[nodeType].blankConfig() },
        };
        return { ...current, nodes: [...current.nodes, node] };
      });
      selectNode(null);
    },
    [selectNode, setGraph],
  );

  const onDrop = React.useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const nodeType = event.dataTransfer.getData(NODE_DRAG_MIME) as NodeType;
      if (!nodeType || !(nodeType in NODE_CATALOG)) return;
      addNode(nodeType, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [addNode, screenToFlowPosition],
  );

  const onDragOver = React.useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  // Condition rules are shown as edge labels at render time only — never written
  // back into the cache, which is the autosave payload.
  const displayEdges = React.useMemo(
    () =>
      graph.edges.map((edge) => {
        const condition = edge.data?.condition ?? null;
        return {
          ...edge,
          selected: edge.id === selectedEdgeId,
          label: condition ? conditionLabel(condition) : undefined,
          labelBgPadding: [6, 3] as [number, number],
          labelBgBorderRadius: 6,
        };
      }),
    [graph.edges, selectedEdgeId],
  );

  const addNodeAtCentre = React.useCallback(
    (nodeType: NodeType) => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Fan repeated clicks out so they don't stack into one opaque pile.
      const offset = (graph.nodes.length % 6) * 28;
      addNode(
        nodeType,
        screenToFlowPosition({ x: rect.left + rect.width / 2 + offset, y: rect.top + rect.height / 3 + offset }),
      );
    },
    [addNode, graph.nodes.length, screenToFlowPosition],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      {readOnly ? null : <NodePalette onAdd={addNodeAtCentre} />}
      <div ref={wrapperRef} className="builder-canvas relative min-w-0 flex-1">
        <ReactFlow<BuilderNode, BuilderEdge>
          nodes={graph.nodes}
          edges={displayEdges}
          nodeTypes={builderNodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onNodeClick={(_, node) => selectNode(node.id)}
          onEdgeClick={(_, edge) => selectEdge(edge.id)}
          onPaneClick={() => selectNode(null)}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable
          deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={1.75}
          proOptions={{ hideAttribution: false }}
          // Dashed connectors are the reference's own idiom for a flow between
          // steps, and they read as a route rather than as a wire. Applied via
          // `defaultEdgeOptions` rather than per-edge in `lib/graph-mapping.ts`:
          // that module round-trips the graph to and from the API and its output
          // is pinned by tests, so presentation must not leak into it.
          defaultEdgeOptions={{ style: { strokeDasharray: "5 4" } }}
          connectionLineStyle={{ strokeDasharray: "5 4" }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap pannable zoomable position="bottom-right" className="hidden md:block" />
        </ReactFlow>

        {graph.nodes.length === 0 ? (
          // A hint, not a blocking EmptyState — the canvas underneath has to stay
          // droppable, which is the whole point of the empty case.
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-2xl bg-popover/90 px-6 py-5 text-center shadow-pop backdrop-blur-sm">
              <p className="text-sm font-medium">Empty canvas</p>
              <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                Drag a Start node from the left, then add the steps it should run.
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Compact `field op value` summary for an edge label. */
function conditionLabel(condition: Record<string, unknown>): string {
  const branch = typeof condition.branch === "string" ? condition.branch : "";
  if (branch) return branch;
  const field = typeof condition.field === "string" ? condition.field.split(".").pop() ?? "" : "";
  const operator = typeof condition.operator === "string" ? condition.operator : "";
  if (!field || !operator) return "rule";
  return `${field} ${operator} ${JSON.stringify(condition.value ?? null)}`;
}
