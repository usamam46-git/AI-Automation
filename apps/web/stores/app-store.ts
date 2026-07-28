import { create } from "zustand";

type AppState = {
  currentWorkspaceId: string | null;
  setCurrentWorkspaceId: (workspaceId: string | null) => void;
};

export const useAppStore = create<AppState>((set) => ({
  currentWorkspaceId: null,
  setCurrentWorkspaceId: (currentWorkspaceId) => set({ currentWorkspaceId }),
}));
