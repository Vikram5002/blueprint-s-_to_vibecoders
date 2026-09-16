import { useEffect, useState } from 'react';
import { useWorkspaceStore } from './store';
import { fetchWorkflowSession, listWorkflowSessions } from './workflow-api-client';
import type { WorkflowSessionSummary } from './workflow-session-types';

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
  const openedSessionId = useWorkspaceStore((state) => state.openedSession?.id);

  const [sessions, setSessions] = useState<readonly WorkflowSessionSummary[]>([]);
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
      className={`flex h-full flex-shrink-0 flex-col border-r border-slate-800 bg-slate-950 transition-[width] duration-150 ${
        collapsed ? 'w-14' : 'w-60'
      }`}
    >
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-3">
        {!collapsed && <span className="text-sm font-semibold text-slate-200">Sessions</span>}
        <button
          type="button"
          onClick={toggleSidebar}
          className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      {!collapsed && (
        <div className="flex-1 overflow-y-auto px-3 py-4 text-sm text-slate-500">
          {loadState.kind === 'error' ? (
            <p className="text-red-300">Could not load sessions: {loadState.message}</p>
          ) : loadState.kind === 'loading' && sessions.length === 0 ? (
            <p>Loading…</p>
          ) : sessions.length === 0 ? (
            <p>No sessions yet.</p>
          ) : (
            <ul className="space-y-1">
              {sessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    data-testid="session-item"
                    onClick={() => void handleOpen(session.id)}
                    disabled={openingId === session.id}
                    aria-current={openedSessionId === session.id ? 'true' : undefined}
                    className="w-full rounded px-2 py-1.5 text-left hover:bg-slate-900 disabled:cursor-wait aria-[current=true]:bg-slate-900 aria-[current=true]:text-slate-200"
                  >
                    <div className="truncate text-slate-300">{session.title}</div>
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
