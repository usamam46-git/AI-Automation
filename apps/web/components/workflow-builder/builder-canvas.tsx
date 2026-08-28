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
  Panel,
  ReactFlow,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
} from "@xyflow/react";
import { Plus, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { NodeType } from "@/lib/api";
import { layoutGraph } from "@/lib/graph-layout";
import { edgeId, type BuilderEdge, type BuilderGraph, type BuilderNode } from "@/lib/graph-mapping";
import { NODE_CATALOG, nextNodeKey, type NodeSearchFilter } from "@/lib/node-catalog";
import { useWorkflowBuilderStore } from "@/stores/workflow-builder-store";
import {
  BuilderActionsProvider,
  NodeOutgoingProvider,
  type BuilderActions,
} from "@/components/workflow-builder/builder-actions-context";
import { builderEdgeTypes } from "@/components/workflow-builder/edges/builder-edge";
import { NodePicker } from "@/components/workflow-builder/node-picker";
import { builderNodeTypes } from "@/components/workflow-builder/nodes/builder-node";

import "@xyflow/react/dist/style.css";
import "@/components/workflow-builder/builder.css";

/** Horizontal step used when placing a node off another node's output handle. */
const STEP_X = 300;
/** Vertical nudge used to find free space beside an occupied slot. */
const STEP_Y = 110;
/** Nominal card size, used only to turn layout positions into a framing box. */
const NODE_WIDTH = 240;
const NODE_HEIGHT = 60;

/**
 * What opened the picker, and therefore where the chosen node goes and which
 * types may be offered. Kept as a discriminated union rather than a stored
 * callback so the placement rules all live in one readable switch.
 */
type PickerRequest =
  | { kind: "add"; at: { x: number; y: number } }
  | { kind: "after"; at: { x: number; y: number }; from: string }
  | { kind: "connect"; at: { x: number; y: number }; from: string; position: { x: number; y: number } }
  | { kind: "insert"; at: { x: number; y: number }; edgeId: string };

const PICKER_FILTERS: Record<PickerRequest["kind"], NodeSearchFilter> = {
  add: {},
  // The gesture promises an incoming edge, so a node with no input handle
  // (`start`) would be added as an instant orphan.
  after: { needsTarget: true },
  connect: { needsTarget: true },
  // Sits between two existing nodes, so it needs both handles.
  insert: { needsTarget: true, needsSource: true },
};

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
  const { screenToFlowPosition, fitBounds } = useReactFlow();
  const selectNode = useWorkflowBuilderStore((state) => state.selectNode);
  const selectEdge = useWorkflowBuilderStore((state) => state.selectEdge);
  const selectedEdgeId = useWorkflowBuilderStore((state) => state.selectedEdgeId);
  const [picker, setPicker] = React.useState<PickerRequest | null>(null);

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

  /**
   * Dragging a connection into empty space opens the picker there — n8n's
   * "drop to add" gesture. React Flow reports the drop as a finished connection
   * with no target when it did not land on a handle.
   */
  const onConnectEnd = React.useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (readOnly || connectionState.isValid) return;
      const from = connectionState.fromNode?.id;
      if (!from) return;

      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      setPicker({
        kind: "connect",
        at: { x: point.clientX + 8, y: point.clientY },
        from,
        position: screenToFlowPosition({ x: point.clientX, y: point.clientY }),
      });
    },
    [readOnly, screenToFlowPosition],
  );

  const handlePick = React.useCallback(
    (nodeType: NodeType) => {
      const request = picker;
      setPicker(null);
      if (!request) return;

      setGraph((current) => {
        const nodeKey = nextNodeKey(nodeType, current.nodes.map((node) => node.id));
        const node: BuilderNode = {
          id: nodeKey,
          type: nodeType,
          position: { x: 0, y: 0 },
          data: { nodeKey, nodeType, config: NODE_CATALOG[nodeType].blankConfig() },
        };

        switch (request.kind) {
          case "add": {
            node.position = placeFree(current.nodes, viewportCentre(wrapperRef.current, screenToFlowPosition));
            return { ...current, nodes: [...current.nodes, node] };
          }

          case "connect": {
            node.position = placeFree(current.nodes, request.position);
            return {
              nodes: [...current.nodes, node],
              edges: [
                ...current.edges,
                { id: edgeId(request.from, nodeKey), source: request.from, target: nodeKey, data: { condition: null } },
              ],
            };
          }

          case "after": {
            const source = current.nodes.find((candidate) => candidate.id === request.from);
            node.position = placeFree(current.nodes, {
              x: (source?.position.x ?? 0) + STEP_X,
              y: source?.position.y ?? 0,
            });
            return {
              nodes: [...current.nodes, node],
              edges: [
                ...current.edges,
                { id: edgeId(request.from, nodeKey), source: request.from, target: nodeKey, data: { condition: null } },
              ],
            };
          }

          case "insert": {
            const edge = current.edges.find((candidate) => candidate.id === request.edgeId);
            if (!edge) return current;
            const source = current.nodes.find((candidate) => candidate.id === edge.source);
            const target = current.nodes.find((candidate) => candidate.id === edge.target);
            node.position = placeFree(current.nodes, {
              x: midpoint(source?.position.x, target?.position.x, STEP_X),
              y: midpoint(source?.position.y, target?.position.y, 0),
            });

            return {
              nodes: [...current.nodes, node],
              edges: [
                ...current.edges.filter((candidate) => candidate.id !== request.edgeId),
                // The rule stays on the leg LEAVING the original source: if that
                // source is a condition node, the predicate is what selects this
                // branch, and moving it downstream would silently make the branch
                // a catch-all.
                { id: edgeId(edge.source, nodeKey), source: edge.source, target: nodeKey, data: edge.data ?? { condition: null } },
                { id: edgeId(nodeKey, edge.target), source: nodeKey, target: edge.target, data: { condition: null } },
              ],
            };
          }
        }
      });

      selectNode(null);
    },
    [picker, screenToFlowPosition, selectNode, setGraph],
  );

  const actions = React.useMemo<BuilderActions>(
    () => ({
      addAfter: (nodeKey, at) => setPicker({ kind: "after", at, from: nodeKey }),
      insertOnEdge: (id, at) => setPicker({ kind: "insert", at, edgeId: id }),
      deleteEdge: (id) =>
        setGraph((current) => ({ ...current, edges: current.edges.filter((edge) => edge.id !== id) })),
      // Wired to the node detail view in phase 2.
      openNode: (nodeKey) => selectNode(nodeKey),
    }),
    [selectNode, setGraph],
  );

  /**
   * Re-run the layered layout over the whole graph. Explicit, never automatic:
   * moving every node is an edit, and an edit on open would autosave a
   * byte-identical version N+1 the moment someone looked at a published graph.
   *
   * It frames the bounds it just COMPUTED rather than calling `fitView`. React
   * Flow measures nodes from its own internal store, which is still holding the
   * pre-layout positions on the next frame — `fitView` (even inside a
   * requestAnimationFrame) framed where the graph used to be and left the tidied
   * row jammed under the toolbar. The positions are already known here, so there
   * is nothing to wait for.
   */
  const tidyUp = React.useCallback(() => {
    const positions = layoutGraph(graph);
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) => ({ ...node, position: positions[node.id] ?? node.position })),
    }));

    const points = Object.values(positions);
    if (points.length === 0) return;
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    fitBounds(
      {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs) + NODE_WIDTH,
        height: Math.max(...ys) - Math.min(...ys) + NODE_HEIGHT,
      },
      { padding: 0.2, duration: 250 },
    );
  }, [fitBounds, graph, setGraph]);

  // Render-time only — `type` and the condition chip must never reach the cache,
  // which is the autosave payload.
  const displayEdges = React.useMemo(
    () =>
      graph.edges.map((edge) => ({
        ...edge,
        type: "builder",
        selected: edge.id === selectedEdgeId,
      })),
    [graph.edges, selectedEdgeId],
  );

  // Which outputs are already connected — decides where the ⊕ affordance shows.
  const nodesWithOutgoing = React.useMemo(
    () => new Set(graph.edges.map((edge) => edge.source)),
    [graph.edges],
  );

  const openPickerAtCentre = React.useCallback(() => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPicker({ kind: "add", at: { x: rect.left + rect.width / 2 - 160, y: rect.top + 96 } });
  }, []);

  return (
    <BuilderActionsProvider actions={actions}>
      <NodeOutgoingProvider nodeKeys={nodesWithOutgoing}>
      <div ref={wrapperRef} className="builder-canvas relative h-full min-h-0 min-w-0 flex-1">
        <ReactFlow<BuilderNode, BuilderEdge>
          nodes={graph.nodes}
          edges={displayEdges}
          nodeTypes={builderNodeTypes}
          edgeTypes={builderEdgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          onNodeClick={(_, node) => selectNode(node.id)}
          onNodeDoubleClick={(_, node) => actions.openNode(node.id)}
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
          defaultEdgeOptions={{ type: "builder", style: { strokeDasharray: "5 4" } }}
          connectionLineStyle={{ strokeDasharray: "5 4" }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap pannable zoomable position="bottom-right" className="hidden md:block" />

          {readOnly ? null : (
            <Panel position="top-right" className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-8 shadow-soft"
                    onClick={tidyUp}
                    disabled={graph.nodes.length === 0}
                  >
                    <Wand2 className="size-3.5" />
                    Tidy up
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Arrange every node left to right</TooltipContent>
              </Tooltip>
              {/* Deliberately NOT lime. The toolbar's Publish is this screen's
                  one primary action; a second lime button beside it would leave
                  neither reading as primary. The empty-canvas card below does
                  take lime, because there Publish is disabled and adding the
                  first step is the only thing to do. */}
              <Button variant="secondary" size="sm" className="h-8 shadow-soft" onClick={openPickerAtCentre}>
                <Plus className="size-3.5" />
                Add node
              </Button>
            </Panel>
          )}
        </ReactFlow>

        {graph.nodes.length === 0 ? (
          // The pane underneath has to stay usable, so this is a hint with one
          // live button rather than a blocking EmptyState.
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="pointer-events-auto rounded-2xl bg-popover/90 px-6 py-5 text-center shadow-pop backdrop-blur-sm">
              <p className="text-sm font-medium">Empty canvas</p>
              <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                Every workflow begins with a Start node, then the steps it should run.
              </p>
              <Button size="sm" className="mt-3 h-8" onClick={openPickerAtCentre}>
                <Plus className="size-3.5" />
                Add first step
              </Button>
            </div>
          </div>
        ) : null}

        {picker ? (
          <NodePicker
            at={picker.at}
            filter={PICKER_FILTERS[picker.kind]}
            title={picker.kind === "insert" ? "Insert a node here…" : "Search nodes…"}
            onPick={handlePick}
            onClose={() => setPicker(null)}
          />
        ) : null}
      </div>
      </NodeOutgoingProvider>
    </BuilderActionsProvider>
  );
}

/** Flow coordinates of the middle of the visible canvas. */
function viewportCentre(
  wrapper: HTMLDivElement | null,
  toFlow: (point: { x: number; y: number }) => { x: number; y: number },
): { x: number; y: number } {
  const rect = wrapper?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return toFlow({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
}

function midpoint(a: number | undefined, b: number | undefined, fallbackStep: number): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return b! - fallbackStep;
  if (b === undefined) return a + fallbackStep;
  return (a + b) / 2;
}

/**
 * Step downwards until the slot is clear. A new node landing exactly on top of
 * an existing one reads as nothing having happened at all.
 */
function placeFree(nodes: readonly BuilderNode[], desired: { x: number; y: number }): { x: number; y: number } {
  const occupied = (point: { x: number; y: number }) =>
    nodes.some(
      (node) => Math.abs(node.position.x - point.x) < STEP_X * 0.6 && Math.abs(node.position.y - point.y) < STEP_Y * 0.8,
    );

  const position = { ...desired };
  // Bounded: a graph cannot have more rows than it has nodes.
  for (let attempt = 0; attempt <= nodes.length && occupied(position); attempt += 1) {
    position.y += STEP_Y;
  }
  return position;
}
