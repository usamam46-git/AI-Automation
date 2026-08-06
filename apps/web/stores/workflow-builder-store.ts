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
  panelOpen: boolean;
  schemaEditorMode: "fields" | "json";
  /** The last rejected publish, parsed out of the server's 422. Not derivable
   *  from a GET — it is the result of an action — so it belongs here, not in
   *  React Query. Cleared on the next successful publish or graph edit. */
  serverIssue: GraphIssue | null;
  selectNode: (nodeKey: string | null) => void;
  selectEdge: (edgeId: string | null) => void;
  setPanelOpen: (panelOpen: boolean) => void;
  setSchemaEditorMode: (schemaEditorMode: "fields" | "json") => void;
  setServerIssue: (serverIssue: GraphIssue | null) => void;
  reset: () => void;
};

const initialState = {
  selectedNodeKey: null,
  selectedEdgeId: null,
  panelOpen: false,
  schemaEditorMode: "fields" as const,
  serverIssue: null,
};

export const useWorkflowBuilderStore = create<WorkflowBuilderState>((set) => ({
  ...initialState,
  selectNode: (selectedNodeKey) => set({ selectedNodeKey, selectedEdgeId: null, panelOpen: selectedNodeKey !== null }),
  selectEdge: (selectedEdgeId) => set({ selectedEdgeId, selectedNodeKey: null, panelOpen: selectedEdgeId !== null }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setSchemaEditorMode: (schemaEditorMode) => set({ schemaEditorMode }),
  setServerIssue: (serverIssue) => set({ serverIssue }),
  reset: () => set(initialState),
}));
