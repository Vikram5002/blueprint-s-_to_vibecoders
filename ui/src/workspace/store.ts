import { create } from 'zustand';
import type { WorkflowSessionDetail } from './workflow-session-types';

export type Tab = 'conversation' | 'layout' | 'page-builder' | 'verification' | 'workflow';

/**
 * Shell-level UI state: sidebar collapse, the active tab, and which
 * persisted workflow session (if any) is currently opened in the Workflow
 * graph tab. `sessionsVersion` is a plain counter, bumped whenever a new
 * session is saved server-side (a live generation reaching 'succeeded') so
 * the Sidebar's session list — fetched once on mount otherwise — knows to
 * refetch without every session-producing component needing a direct
 * reference to the sidebar's own fetch logic.
 */
export interface WorkspaceState {
  readonly sidebarCollapsed: boolean;
  readonly toggleSidebar: () => void;
  readonly activeTab: Tab;
  readonly setActiveTab: (tab: Tab) => void;
  readonly openedSession: WorkflowSessionDetail | null;
  /** Switches to the Workflow graph tab and loads `session` into it. */
  readonly openSession: (session: WorkflowSessionDetail) => void;
  /** Consumed exactly once by WorkflowDemo after it picks up `openedSession` on mount. */
  readonly clearOpenedSession: () => void;
  readonly sessionsVersion: number;
  readonly notifySessionSaved: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  activeTab: 'conversation',
  setActiveTab: (tab) => set({ activeTab: tab }),
  openedSession: null,
  openSession: (session) => set({ activeTab: 'workflow', openedSession: session }),
  clearOpenedSession: () => set({ openedSession: null }),
  sessionsVersion: 0,
  notifySessionSaved: () => set((state) => ({ sessionsVersion: state.sessionsVersion + 1 })),
}));
