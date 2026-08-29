import { create } from "zustand";
import type { GraphIssue } from "@/lib/graph-validation";

/**
 * Builder UI annotations only. The graph itself is server state and lives in
 * the React Query cache under ['workflow-graph', workflowId, versionId] — see
 * apps/web/CLAUDE.md's state-management split. Nothing derivable from a GET
 * belongs in here.
 */
type WorkflowBuilderState = {
  selectedNodeKey: string | null;
  selectedEdgeId: string | null;
  /**
   * The node whose detail view is open, or null. Deliberately SEPARATE from
   * `selectedNodeKey`: single-clicking a node selects it on the canvas (ring,
   * delete key, ⊕ visible) while double-click opens the full-screen editor, and
   * collapsing the two would mean every stray click threw a modal in your face.
   */
  detailNodeKey: string | null;
  panelOpen: boolean;
  schemaEditorMode: "fields" | "json";
  /** The last rejected publish, parsed out of the server's 422. Not derivable
   *  from a GET — it is the result of an action — so it belongs here, not in
   *  React Query. Cleared on the next successful publish or graph edit. */
  serverIssue: GraphIssue | null;
  selectNode: (nodeKey: string | null) => void;
  selectEdge: (edgeId: string | null) => void;
  openDetail: (nodeKey: string) => void;
  closeDetail: () => void;
  setPanelOpen: (panelOpen: boolean) => void;
  setSchemaEditorMode: (schemaEditorMode: "fields" | "json") => void;
  setServerIssue: (serverIssue: GraphIssue | null) => void;
  reset: () => void;
};

const initialState = {
  selectedNodeKey: null,
  selectedEdgeId: null,
  detailNodeKey: null,
  panelOpen: false,
  schemaEditorMode: "fields" as const,
  serverIssue: null,
};

export const useWorkflowBuilderStore = create<WorkflowBuilderState>((set) => ({
  ...initialState,
  selectNode: (selectedNodeKey) => set({ selectedNodeKey, selectedEdgeId: null, panelOpen: selectedNodeKey !== null }),
  selectEdge: (selectedEdgeId) => set({ selectedEdgeId, selectedNodeKey: null, panelOpen: selectedEdgeId !== null }),
  // Opening the detail view also selects the node, so closing it leaves the
  // canvas focused on what you were just editing rather than on nothing.
  openDetail: (detailNodeKey) => set({ detailNodeKey, selectedNodeKey: detailNodeKey, selectedEdgeId: null }),
  closeDetail: () => set({ detailNodeKey: null }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setSchemaEditorMode: (schemaEditorMode) => set({ schemaEditorMode }),
  setServerIssue: (serverIssue) => set({ serverIssue }),
  reset: () => set(initialState),
}));
