import { create } from 'zustand';
import type { WorkflowSessionDetail } from './workflow-session-types';
import type { CanvasElement, PageLayout } from './page-builder-types';

export type Tab = 'conversation' | 'layout' | 'page-builder' | 'verification' | 'workflow';

/**
 * Where a Page Builder canvas came from, when it is one of a generated
 * run's real pages rather than a scratch page: saving writes the page's
 * file back into that run, and the zip download includes the edit.
 */
export interface PageOrigin {
  readonly runId: string;
  readonly sessionId: string;
  readonly sessionTitle: string;
  /** Repo-relative path of the page's file in the run, e.g. frontend/src/pages/home.tsx. */
  readonly path: string;
  /** True once a Page Builder save has replaced the model's file - what "Restore original" undoes. */
  readonly edited: boolean;
}

export interface PageBuilderState {
  readonly pageName: string;
  readonly elements: readonly CanvasElement[];
  readonly selectedId: string | null;
  readonly origin: PageOrigin | null;
}

/**
 * Shell-level UI state: sidebar collapse, the active tab, the workflow
 * session currently shown in the Workflow graph tab, and the Page Builder
 * canvas.
 *
 * Tab panels unmount when another tab is shown (WorkspaceShell renders one
 * at a time), so anything that must survive a tab switch lives here rather
 * than in a panel's own useState: the opened session (so coming back to the
 * Workflow tab shows the same session, and its saved run, instead of the
 * empty view), and the canvas (so a half-edited page is not wiped by a
 * glance at another tab). Found live: both were lost on every switch.
 *
 * `sessionsVersion` / `runsVersion` are plain counters, bumped whenever a
 * session or an application run is saved server-side, so the Sidebar - which
 * fetches once otherwise - knows to refetch.
 */
export interface WorkspaceState {
  readonly sidebarCollapsed: boolean;
  readonly toggleSidebar: () => void;
  readonly activeTab: Tab;
  readonly setActiveTab: (tab: Tab) => void;
  /** The session shown in the Workflow graph tab. Stays set across tab switches; replaced, never cleared, by opening another. */
  readonly openedSession: WorkflowSessionDetail | null;
  /** Switches to the Workflow graph tab and loads `session` into it. */
  readonly openSession: (session: WorkflowSessionDetail) => void;
  /** Records a session that was just generated in place, without changing tabs. */
  readonly rememberSession: (session: WorkflowSessionDetail) => void;
  readonly sessionsVersion: number;
  readonly notifySessionSaved: () => void;
  readonly runsVersion: number;
  readonly notifyRunSaved: () => void;

  readonly pageBuilder: PageBuilderState;
  readonly setPageName: (pageName: string) => void;
  readonly setElements: (update: (current: readonly CanvasElement[]) => readonly CanvasElement[]) => void;
  readonly setSelectedId: (id: string | null) => void;
  /** Loads one of a run's pages into the canvas and switches to the Page Builder tab. */
  readonly openPageInBuilder: (origin: PageOrigin, layout: PageLayout) => void;
  readonly setPageOrigin: (origin: PageOrigin | null) => void;
}

const EMPTY_CANVAS: PageBuilderState = { pageName: 'Landing Page', elements: [], selectedId: null, origin: null };

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  activeTab: 'conversation',
  setActiveTab: (tab) => set({ activeTab: tab }),
  openedSession: null,
  openSession: (session) => set({ activeTab: 'workflow', openedSession: session }),
  rememberSession: (session) => set({ openedSession: session }),
  sessionsVersion: 0,
  notifySessionSaved: () => set((state) => ({ sessionsVersion: state.sessionsVersion + 1 })),
  runsVersion: 0,
  notifyRunSaved: () => set((state) => ({ runsVersion: state.runsVersion + 1 })),

  pageBuilder: EMPTY_CANVAS,
  setPageName: (pageName) => set((state) => ({ pageBuilder: { ...state.pageBuilder, pageName } })),
  setElements: (update) => set((state) => ({ pageBuilder: { ...state.pageBuilder, elements: update(state.pageBuilder.elements) } })),
  setSelectedId: (selectedId) => set((state) => ({ pageBuilder: { ...state.pageBuilder, selectedId } })),
  openPageInBuilder: (origin, layout) =>
    set({
      activeTab: 'page-builder',
      pageBuilder: { pageName: layout.pageName, elements: layout.elements, selectedId: null, origin },
    }),
  setPageOrigin: (origin) => set((state) => ({ pageBuilder: { ...state.pageBuilder, origin } })),
}));
