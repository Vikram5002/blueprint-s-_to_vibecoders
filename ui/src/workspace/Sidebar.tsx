import { useEffect, useMemo, useState } from 'react';
import { useWorkspaceStore } from './store';
import {
  deleteWorkflowSession,
  fetchLatestRuns,
  fetchWorkflowSession,
  listWorkflowSessions,
} from './workflow-api-client';
import { ImportProjectDialog } from './ImportProjectDialog';
import { Icon } from '../design/Icon';
import { LogoMark, Wordmark } from '../design/Logo';
import type { WorkflowSessionSummary } from './workflow-session-types';
import type { LatestRun } from './application-job-types';

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loaded' };

interface SessionGroup {
  readonly label: string;
  readonly sessions: readonly WorkflowSessionSummary[];
}

const DAY_MS = 86_400_000;

/** Today / Yesterday / Previous 7 days / Earlier, newest first - how a person remembers when they worked on something. */
export function groupSessions(
  sessions: readonly WorkflowSessionSummary[],
  now: Date,
): readonly SessionGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets: { label: string; from: number; sessions: WorkflowSessionSummary[] }[] = [
    { label: 'Today', from: startOfToday, sessions: [] },
    { label: 'Yesterday', from: startOfToday - DAY_MS, sessions: [] },
    { label: 'Previous 7 days', from: startOfToday - 7 * DAY_MS, sessions: [] },
    { label: 'Earlier', from: Number.NEGATIVE_INFINITY, sessions: [] },
  ];
  for (const session of sessions) {
    const time = new Date(session.createdAt).getTime();
    const bucket = buckets.find((candidate) =>
      Number.isNaN(time) ? candidate.from === Number.NEGATIVE_INFINITY : time >= candidate.from,
    );
    bucket?.sessions.push(session);
  }
  return buckets
    .filter((bucket) => bucket.sessions.length > 0)
    .map(({ label, sessions: items }) => ({ label, sessions: items }));
}

/** The time for today's sessions, the day for older ones - short enough to sit beside a title. */
function formatWhen(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(
    undefined,
    sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' },
  ).format(date);
}

/**
 * 240px expanded, a 56px rail when collapsed (collapse state lives in the
 * store). Projects are real, persisted workflow sessions
 * (`/api/workflow/sessions`), refetched whenever `sessionsVersion` changes;
 * clicking one fetches its full detail and opens it in the Workflow tab via
 * `openSession` - never a partial render from the summary alone.
 */
export function Sidebar(): JSX.Element {
  const collapsed = useWorkspaceStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar);
  const sessionsVersion = useWorkspaceStore((state) => state.sessionsVersion);
  const openSession = useWorkspaceStore((state) => state.openSession);
  const startNewProject = useWorkspaceStore((state) => state.startNewProject);
  const importOpen = useWorkspaceStore((state) => state.importOpen);
  const setImportOpen = useWorkspaceStore((state) => state.setImportOpen);
  const openedSessionId = useWorkspaceStore((state) => state.openedSession?.id);
  const runsVersion = useWorkspaceStore((state) => state.runsVersion);

  const [sessions, setSessions] = useState<readonly WorkflowSessionSummary[]>([]);
  /** The newest generated application per session - a dot next to the title says whether it built. */
  const [latestRuns, setLatestRuns] = useState<ReadonlyMap<string, LatestRun>>(new Map());
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  /** The row asking "Delete?" - a second click is required, so one stray click deletes nothing. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{
    readonly id: string;
    readonly message: string;
  } | null>(null);
  const notifySessionSaved = useWorkspaceStore((state) => state.notifySessionSaved);

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
        setLoadState({
          kind: 'error',
          message: cause instanceof Error ? cause.message : String(cause),
        });
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

  const now = new Date();
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching =
      needle === ''
        ? sessions
        : sessions.filter((session) => session.title.toLowerCase().includes(needle));
    return groupSessions(matching, new Date());
  }, [sessions, query]);

  async function handleDelete(id: string): Promise<void> {
    setDeletingId(id);
    try {
      await deleteWorkflowSession(id);
      setSessions((list) => list.filter((session) => session.id !== id));
      setConfirmingId(null);
      // A deleted project cannot stay open; start fresh rather than showing a plan that no longer exists.
      if (openedSessionId === id) startNewProject();
      notifySessionSaved();
    } catch (cause) {
      setConfirmingId(null);
      setDeleteError({ id, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setDeletingId(null);
    }
  }

  async function handleOpen(id: string): Promise<void> {
    setOpeningId(id);
    try {
      openSession(await fetchWorkflowSession(id));
    } catch {
      // Left for the next click to retry - only the detail fetch failed.
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <aside
      className={`relative flex h-full flex-shrink-0 flex-col border-r border-white/[0.06] bg-[#0e0e11] transition-[width] duration-300 ease-apple ${
        collapsed ? 'w-14' : 'w-60'
      }`}
    >
      <div
        className={`flex items-center pb-3 pt-3.5 ${collapsed ? 'flex-col gap-3 px-2' : 'justify-between px-3.5'}`}
      >
        {collapsed ? <LogoMark size={26} /> : <Wordmark />}
        <button
          type="button"
          onClick={toggleSidebar}
          className="btn btn-ghost btn-sm !h-7 !w-7 !p-0"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <Icon name={collapsed ? 'chevrons-right' : 'chevrons-left'} size={15} />
        </button>
      </div>

      <div className={collapsed ? 'flex flex-col items-center gap-2 px-2' : 'space-y-2 px-3'}>
        <button
          type="button"
          data-testid="new-project"
          onClick={startNewProject}
          title="Start a new project in Agent mode"
          className={`btn btn-primary ${collapsed ? 'btn-icon !h-9 !w-9 !rounded-[11px]' : 'w-full'}`}
        >
          <Icon name="plus" size={15} strokeWidth={2.2} />
          {!collapsed && 'New project'}
        </button>
        {!collapsed && (
          <label className="focus-glow flex items-center gap-2 rounded-[10px] border border-white/[0.07] bg-white/[0.03] px-2.5">
            <Icon name="search" size={14} className="text-slate-500" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search projects"
              aria-label="Search projects"
              className="h-8 min-w-0 flex-1 bg-transparent text-[13px] text-slate-100 placeholder:text-slate-500 focus-visible:outline-none"
            />
          </label>
        )}
      </div>

      {!collapsed && (
        <nav aria-label="Projects" className="mt-3 flex-1 overflow-y-auto px-2 pb-3">
          {loadState.kind === 'error' ? (
            <p className="px-2 text-xs text-red-300">
              Could not load projects: {loadState.message}
            </p>
          ) : loadState.kind === 'loading' && sessions.length === 0 ? (
            <div className="space-y-2 px-1.5 pt-1" aria-label="Loading projects">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="skeleton h-9" />
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <p className="px-2.5 pt-2 text-xs leading-relaxed text-slate-500">
              No projects yet. Describe one in Agent mode and it appears here.
            </p>
          ) : groups.length === 0 ? (
            <p className="px-2.5 pt-2 text-xs text-slate-500">
              Nothing matches &ldquo;{query}&rdquo;.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.label} className="mb-3">
                <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium text-slate-500">
                  {group.label}
                </div>
                <ul className="space-y-px">
                  {group.sessions.map((session) => {
                    const current = openedSessionId === session.id;
                    const confirming = confirmingId === session.id;
                    return (
                      <li key={session.id} className="group/row relative">
                        <button
                          type="button"
                          data-testid="session-item"
                          onClick={() => void handleOpen(session.id)}
                          disabled={openingId === session.id}
                          aria-current={current ? 'true' : undefined}
                          title={session.title}
                          className="group relative flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-[7px] text-left hover:bg-white/[0.045] disabled:cursor-wait aria-[current=true]:bg-white/[0.07]"
                        >
                          {current && (
                            <span
                              aria-hidden="true"
                              className="absolute inset-y-2 left-0 w-[2.5px] rounded-full bg-gradient-to-b from-violet-400 to-sky-500"
                            />
                          )}
                          {openingId === session.id ? (
                            <span className="spinner !h-2.5 !w-2.5 !border" />
                          ) : (
                            <RunDot run={latestRuns.get(session.id)} />
                          )}
                          <span className="min-w-0 flex-1 truncate text-[13px] text-slate-300 group-hover:text-slate-100 group-aria-[current=true]:font-medium group-aria-[current=true]:text-slate-50">
                            {session.title}
                          </span>
                          <span className="flex-shrink-0 text-[11px] tabular-nums text-slate-500 transition-opacity group-focus-within/row:opacity-0 group-hover/row:opacity-0">
                            {formatWhen(session.createdAt, now)}
                          </span>
                        </button>
                        {confirming ? (
                          <div
                            className="absolute inset-y-0 right-1 flex items-center gap-1 rounded-[9px] bg-[#0e0e11] pl-2"
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') setConfirmingId(null);
                            }}
                          >
                            <button
                              type="button"
                              data-testid="confirm-delete-session"
                              onClick={() => void handleDelete(session.id)}
                              disabled={deletingId === session.id}
                              className="rounded-[7px] bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-300 hover:bg-red-500/25 disabled:cursor-wait"
                            >
                              {deletingId === session.id ? 'Deleting…' : 'Delete'}
                            </button>
                            <button
                              type="button"
                              // Focus moves into the confirmation the person just opened.
                              autoFocus
                              onClick={() => setConfirmingId(null)}
                              className="rounded-[7px] px-2 py-0.5 text-[11px] text-slate-400 hover:bg-white/[0.06] hover:text-slate-200"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            data-testid="delete-session"
                            onClick={() => {
                              setDeleteError(null);
                              setConfirmingId(session.id);
                            }}
                            aria-label={`Delete ${session.title}`}
                            title="Delete this project, its runs and generated files"
                            className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[7px] text-slate-500 opacity-0 transition-opacity hover:bg-white/[0.06] hover:text-red-300 focus-visible:opacity-100 group-hover/row:opacity-100"
                          >
                            <Icon name="trash" size={13} />
                          </button>
                        )}
                        {deleteError?.id === session.id && (
                          <p
                            role="alert"
                            className="px-2.5 pb-1 pt-0.5 text-[11px] leading-snug text-red-300"
                          >
                            {deleteError.message}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </nav>
      )}

      <div
        className={`mt-auto border-t border-white/[0.06] ${collapsed ? 'flex justify-center px-2 py-3' : 'px-3 py-3'}`}
      >
        <button
          type="button"
          data-testid="open-import"
          onClick={() => setImportOpen(true)}
          title="Continue a project you have been building - from a folder or Git"
          className={`btn btn-ghost ${collapsed ? 'btn-icon' : 'w-full !justify-start'}`}
        >
          <Icon name="folder" size={15} />
          {!collapsed && 'Import a project'}
        </button>
      </div>
      {importOpen && <ImportProjectDialog onClose={() => setImportOpen(false)} />}
    </aside>
  );
}

/** Green: the last generated application built. Red: it did not (open it to fix). Hollow: never generated. */
function RunDot({ run }: { readonly run: LatestRun | undefined }): JSX.Element {
  if (run === undefined) {
    return (
      <span
        aria-hidden="true"
        className="h-[7px] w-[7px] flex-shrink-0 rounded-full border border-slate-600"
      />
    );
  }
  const built = run.status === 'succeeded' && run.buildOk;
  return (
    <span
      data-testid="run-dot"
      data-built={built}
      title={
        built
          ? 'Last generated application built successfully'
          : 'Last generated application failed to build - open to fix'
      }
      className={`h-[7px] w-[7px] flex-shrink-0 rounded-full ${built ? 'bg-emerald-400 shadow-[0_0_8px_rgba(48,209,88,0.6)]' : 'bg-red-400 shadow-[0_0_8px_rgba(255,69,58,0.5)]'}`}
    />
  );
}
