import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Session-scoped UI state. Server state belongs in React Query — see
 * apps/web/CLAUDE.md's state-management split.
 *
 * **The workspace selection is persisted, and it has to be.** Everything
 * workspace-scoped (workflows, tools, knowledge bases) reads `currentWorkspaceId`,
 * and without persistence it started as `null` on every page load, so the shell
 * fell back to the *first* workspace in the list. An org with one workspace never
 * noticed; an org with two silently changed workspace on every reload, and the
 * user's lists changed under them with no action on their part.
 *
 * Two things keep the stored id honest, both in `dashboard-shell.tsx`:
 *
 * - A stored id that is not in the fetched list (workspace archived, or a
 *   different user signing in on the same browser) is **corrected** to the first
 *   workspace rather than left in place. Leaving it would filter every list by an
 *   id the API will never match, showing empty pages while the header named a
 *   workspace that had content.
 * - Logout clears it, so the next account does not start inside a stale id.
 *
 * `localStorage` is deliberate over a cookie: nothing server-side reads this, and
 * the value is a workspace UUID the user can already see in their own URLs. The
 * access token stays in memory (never storage) — that rule is unchanged.
 */
type AppState = {
  currentWorkspaceId: string | null;
  setCurrentWorkspaceId: (workspaceId: string | null) => void;
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      currentWorkspaceId: null,
      setCurrentWorkspaceId: (currentWorkspaceId) => set({ currentWorkspaceId }),
    }),
    {
      name: "orkest.workspace",
      storage: createJSONStorage(() => localStorage),
      // Persist the selection only. Actions are re-created on every load, and a
      // stored function would be dead weight the middleware has to skip anyway.
      partialize: (state) => ({ currentWorkspaceId: state.currentWorkspaceId }),
      version: 1,
    },
  ),
);
