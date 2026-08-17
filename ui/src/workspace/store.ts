import { create } from 'zustand';

/**
 * Shell-level UI state only — sidebar collapse, today. Deliberately not the
 * home for anything session/message-related yet: that needs a real API
 * behind it, and this shell has none (placeholder content only, see
 * ConversationPane and Sidebar).
 */
export interface WorkspaceState {
  readonly sidebarCollapsed: boolean;
  readonly toggleSidebar: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
}));
