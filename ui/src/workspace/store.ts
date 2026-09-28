import { create } from 'zustand';
import type { PageTheme } from './page-theme';
import type { WorkflowSessionDetail } from './workflow-session-types';
import type { CanvasElement, PageLayout } from './page-builder-types';

export type Tab = 'conversation' | 'page-builder' | 'verification' | 'workflow';

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
  /** The page's theme; undefined = the default look. */
  readonly theme?: PageTheme;
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
  /**
   * `coalesce` merges this change into the previous undo step when it follows
   * within HISTORY_COALESCE_MS - for continuous edits (typing, nudging,
   * resizing). Discrete actions (drop, delete, template) never pass it, so
   * each is always its own step.
   */
  readonly setElements: (update: (current: readonly CanvasElement[]) => readonly CanvasElement[], options?: { readonly coalesce?: boolean }) => void;
  readonly setSelectedId: (id: string | null) => void;
  /** Loads one of a run's pages into the canvas and switches to the Page Builder tab. */
  readonly openPageInBuilder: (origin: PageOrigin, layout: PageLayout) => void;
  readonly setPageOrigin: (origin: PageOrigin | null) => void;
  readonly setPageTheme: (theme: PageTheme | undefined) => void;
  /** Canvas undo/redo: element lists before (past) and after (future) the current one. */
  readonly pageHistory: { readonly past: readonly (readonly CanvasElement[])[]; readonly future: readonly (readonly CanvasElement[])[] };
  readonly undoPage: () => void;
  readonly redoPage: () => void;
}

/** Changes closer together than this (typing a label, nudging with arrows) undo as one step. */
const HISTORY_COALESCE_MS = 600;
const HISTORY_LIMIT = 100;
let lastHistoryPush = 0;
/** Whether the latest step came from a continuous edit - only those may absorb the next one. */
let lastStepContinuous = false;

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
  setElements: (update, options) =>
    set((state) => {
      const before = state.pageBuilder.elements;
      const after = update(before);
      if (after === before) return {};
      const now = Date.now();
      const continuous = options?.coalesce === true;
      const coalesce = continuous && lastStepContinuous && now - lastHistoryPush < HISTORY_COALESCE_MS && state.pageHistory.past.length > 0;
      lastHistoryPush = now;
      lastStepContinuous = continuous;
      const past = coalesce ? state.pageHistory.past : [...state.pageHistory.past, before].slice(-HISTORY_LIMIT);
      return { pageBuilder: { ...state.pageBuilder, elements: after }, pageHistory: { past, future: [] } };
    }),
  setSelectedId: (selectedId) => set((state) => ({ pageBuilder: { ...state.pageBuilder, selectedId } })),
  openPageInBuilder: (origin, layout) =>
    set({
      activeTab: 'page-builder',
      pageBuilder: { pageName: layout.pageName, elements: layout.elements, selectedId: null, origin, ...(layout.theme === undefined ? {} : { theme: layout.theme }) },
      pageHistory: { past: [], future: [] },
    }),
  setPageOrigin: (origin) => set((state) => ({ pageBuilder: { ...state.pageBuilder, origin } })),
  setPageTheme: (theme) =>
    set((state) => {
      const { theme: _previous, ...rest } = state.pageBuilder;
      return { pageBuilder: theme === undefined ? rest : { ...rest, theme } };
    }),
  pageHistory: { past: [], future: [] },
  undoPage: () =>
    set((state) => {
      const previous = state.pageHistory.past.at(-1);
      if (previous === undefined) return {};
      lastHistoryPush = 0;
      const stillThere = previous.some((element) => element.id === state.pageBuilder.selectedId);
      return {
        pageBuilder: { ...state.pageBuilder, elements: previous, selectedId: stillThere ? state.pageBuilder.selectedId : null },
        pageHistory: { past: state.pageHistory.past.slice(0, -1), future: [state.pageBuilder.elements, ...state.pageHistory.future] },
      };
    }),
  redoPage: () =>
    set((state) => {
      const next = state.pageHistory.future[0];
      if (next === undefined) return {};
      lastHistoryPush = 0;
      return {
        pageBuilder: { ...state.pageBuilder, elements: next },
        pageHistory: { past: [...state.pageHistory.past, state.pageBuilder.elements], future: state.pageHistory.future.slice(1) },
      };
    }),
}));
