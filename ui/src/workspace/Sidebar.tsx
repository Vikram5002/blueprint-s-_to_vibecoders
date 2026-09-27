import { useEffect, useState } from 'react';
import { useWorkspaceStore } from './store';
import { fetchLatestRuns, fetchWorkflowSession, listWorkflowSessions } from './workflow-api-client';
import { ImportProjectDialog } from './ImportProjectDialog';
import type { WorkflowSessionSummary } from './workflow-session-types';
import type { LatestRun } from './application-job-types';

type LoadState = { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'loaded' };

/** `Intl.DateTimeFormat`, not a relative-time library — one small, dependency-free formatter for one place that needs it. */
function formatSessionDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/**
 * 240px expanded, a narrow icon rail when collapsed. Collapse state lives in
 * the Zustand store rather than local state so other regions could react to
 * it later without prop drilling — not needed today, but cheap to set up
 * right the first time.
 *
 * Sessions are real, persisted workflow generation runs
 * (src/store/workflow-sessions-store.ts, `/api/workflow/sessions`) — fetched
 * on mount and refetched whenever `sessionsVersion` changes (bumped by
 * WorkflowDemo the moment a live generation reaches 'succeeded'). Clicking
 * one fetches its full detail and opens it in the Workflow graph tab via
 * `openSession` — never a partial render from the summary alone, since the
 * summary list intentionally omits the schema/prohibitions/permissions body.
 */
export function Sidebar(): JSX.Element {
  const collapsed = useWorkspaceStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar);
  const sessionsVersion = useWorkspaceStore((state) => state.sessionsVersion);
  const openSession = useWorkspaceStore((state) => state.openSession);
  const [importing, setImporting] = useState(false);
  const openedSessionId = useWorkspaceStore((state) => state.openedSession?.id);
  const runsVersion = useWorkspaceStore((state) => state.runsVersion);

  const [sessions, setSessions] = useState<readonly WorkflowSessionSummary[]>([]);
  /** The newest generated application per session - a dot next to the title says whether it built. */
  const [latestRuns, setLatestRuns] = useState<ReadonlyMap<string, LatestRun>>(new Map());
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadState({ kind: 'loading' });
    listWorkflowSessions()
      .then((list) => {
        if (cancelled) return;
        setSessions(list);
        setLoadState({ kind: 'loaded' });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionsVersion]);

  useEffect(() => {
    let cancelled = false;
    fetchLatestRuns()
      .then((runs) => {
        if (!cancelled) setLatestRuns(new Map(runs.map((run) => [run.sessionId, run])));
      })
      .catch(() => {
        // Without this the list still works; the dots just stay absent.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionsVersion, runsVersion]);

  async function handleOpen(id: string): Promise<void> {
    setOpeningId(id);
    try {
      const detail = await fetchWorkflowSession(id);
      openSession(detail);
    } catch {
      // Left for the next click to retry — the sidebar's own list still
      // reflects reality either way, only the detail fetch failed.
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <aside
      className={`flex h-full flex-shrink-0 flex-col border-r border-white/[0.08] bg-slate-950 transition-[width] duration-300 ease-apple ${
        collapsed ? 'w-14' : 'w-60'
      }`}
    >
      <div className="flex items-center justify-between px-3 pb-2 pt-3.5">
        {!collapsed && <span className="text-[13px] font-semibold tracking-tight text-slate-100">Sessions</span>}
        {!collapsed && (
          <button
            type="button"
            data-testid="open-import"
            onClick={() => setImporting(true)}
            title="Continue a project you have been building - from a folder or Git"
            className="ml-auto mr-1 rounded-md border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-white/[0.06]"
          >
            ⇪ Import
          </button>
        )}
        {importing && <ImportProjectDialog onClose={() => setImporting(false)} />}
        <button
          type="button"
          onClick={toggleSidebar}
          className="rounded-md p-1 text-slate-400 hover:bg-white/[0.08] hover:text-slate-100"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      {!collapsed && (
        <div className="flex-1 overflow-y-auto px-2 py-2 text-sm text-slate-500">
          {loadState.kind === 'error' ? (
            <p className="text-red-300">Could not load sessions: {loadState.message}</p>
          ) : loadState.kind === 'loading' && sessions.length === 0 ? (
            <p>Loading…</p>
          ) : sessions.length === 0 ? (
            <p>No sessions yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {sessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    data-testid="session-item"
                    onClick={() => void handleOpen(session.id)}
                    disabled={openingId === session.id}
                    aria-current={openedSessionId === session.id ? 'true' : undefined}
                    className="w-full rounded-lg px-2.5 py-2 text-left hover:bg-white/[0.05] disabled:cursor-wait aria-[current=true]:bg-sky-500/[0.16] aria-[current=true]:text-slate-100"
                  >
                    <div className="flex items-center gap-1.5">
                      <RunDot run={latestRuns.get(session.id)} />
                      <span className="truncate text-[13px] font-medium text-slate-200">{session.title}</span>
                    </div>
                    <div className="text-xs text-slate-500">
                      {openingId === session.id ? 'Opening…' : formatSessionDate(session.createdAt)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}

/** Green: the last generated application built. Red: it did not (open the session to fix it). Nothing: never generated. */
function RunDot({ run }: { readonly run: LatestRun | undefined }): JSX.Element | null {
  if (run === undefined) return null;
  const built = run.status === 'succeeded' && run.buildOk;
  return (
    <span
      data-testid="run-dot"
      data-built={built}
      title={built ? 'Last generated application built successfully' : 'Last generated application failed to build - open to fix'}
      className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${built ? 'bg-emerald-400' : 'bg-red-400'}`}
    />
  );
}
