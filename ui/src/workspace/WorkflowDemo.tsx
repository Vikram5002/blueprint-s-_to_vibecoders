import { useEffect, useRef, useState, type FormEvent } from 'react';
import { WorkflowGraph } from './WorkflowGraph';
import { GenerateApplicationPanel } from './GenerateApplicationPanel';
import {
  SMALL_PROJECT_SCHEMA,
  LARGE_PROJECT_SCHEMA,
  KNOWN_TENSION_SCHEMA,
  SCALE_TEST_SCHEMA,
  SINGLE_COMPONENT_SCHEMA,
} from './workflow-mocks';
import { generateProjectSchemaViaApi } from './workflow-api-client';
import { useWorkspaceStore } from './store';
import type { WorkflowJob, WorkflowJobResult, WorkflowJobStatus } from './workflow-job-types';
import type { WorkflowSessionDetail } from './workflow-session-types';

type Scenario = 'small' | 'large' | 'tension' | 'scale-test' | 'single-component';
type Mode = 'mock' | 'live';

/**
 * The workflow graph, reached via the "Workflow graph" tab in WorkspaceShell.
 *
 * Two independent data paths, switched by a top-level toggle:
 *
 * - Mock (the original path, unchanged): SMALL_PROJECT_SCHEMA /
 *   LARGE_PROJECT_SCHEMA, hand-built ProjectSchema fixtures. Kept exactly as
 *   it was — same scenario buttons, same warning banner, same behavior —
 *   since it remains useful for UI development and Playwright coverage may
 *   depend on it (ADR-001's zero-regression requirement, extended to this
 *   whole demo, not just WorkflowGraph's edge rendering).
 * - Live: POSTs a prompt to /api/workflow/jobs (src/server/workflow-api.ts)
 *   and polls until the job is done (docs/ADR-002), then renders the real
 *   ValidatedProjectSchema plus the compiler's prohibitions via
 *   WorkflowGraph's prohibitions prop (docs/ADR-001, Option C).
 */
export function WorkflowDemo(): JSX.Element {
  const [mode, setMode] = useState<Mode>('mock');
  const [scenario, setScenario] = useState<Scenario>('small');
  const openedSession = useWorkspaceStore((state) => state.openedSession);
  const clearOpenedSession = useWorkspaceStore((state) => state.clearOpenedSession);
  // Captured into local state rather than read directly from the store: the
  // store's own copy is cleared right below (so reopening the SAME session a
  // second time still fires this effect), and LiveWorkflow's `key` is
  // derived from this value — if that key were derived from the store's
  // copy instead, clearing it out from under an already-open session would
  // change the key mid-render, unmounting LiveWorkflow and remounting it
  // with `initialSession=null`, silently dropping right back to the empty
  // idle view. Found live: clicking a session correctly switched to this
  // tab but rendered "Enter a prompt above..." instead of the session.
  const [loadedSession, setLoadedSession] = useState<WorkflowSessionDetail | null>(null);

  // A session opened from the Sidebar always lands on the live view, even if
  // this tab was last left on a mock scenario — reopening a real past run to
  // find it silently replaced by an unrelated hand-built fixture would be a
  // worse surprise than switching modes underneath the user once, here.
  useEffect(() => {
    if (openedSession === null) return;
    setLoadedSession(openedSession);
    setMode('live');
    clearOpenedSession();
  }, [openedSession, clearOpenedSession]);

  const mockSchema =
    scenario === 'small'
      ? SMALL_PROJECT_SCHEMA
      : scenario === 'large'
        ? LARGE_PROJECT_SCHEMA
        : scenario === 'tension'
          ? KNOWN_TENSION_SCHEMA
          : scenario === 'scale-test'
            ? SCALE_TEST_SCHEMA
            : SINGLE_COMPONENT_SCHEMA;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-950 px-4 py-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode('mock')}
            data-active={mode === 'mock'}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 data-[active=true]:border-slate-400 data-[active=true]:bg-slate-800 data-[active=true]:text-slate-100"
          >
            Mock data
          </button>
          <button
            type="button"
            onClick={() => setMode('live')}
            data-active={mode === 'live'}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 data-[active=true]:border-slate-400 data-[active=true]:bg-slate-800 data-[active=true]:text-slate-100"
          >
            Generate from prompt
          </button>
        </div>

        {mode === 'mock' && (
          <>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setScenario('small')}
                data-active={scenario === 'small'}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 data-[active=true]:border-slate-400 data-[active=true]:bg-slate-800 data-[active=true]:text-slate-100"
              >
                Small project
              </button>
              <button
                type="button"
                onClick={() => setScenario('large')}
                data-active={scenario === 'large'}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 data-[active=true]:border-slate-400 data-[active=true]:bg-slate-800 data-[active=true]:text-slate-100"
              >
                Large project (350-component scale test)
              </button>
              <button
                type="button"
                onClick={() => setScenario('tension')}
                data-active={scenario === 'tension'}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 data-[active=true]:border-slate-400 data-[active=true]:bg-slate-800 data-[active=true]:text-slate-100"
              >
                Known-tension fixture (Milestone 1)
              </button>
              <button
                type="button"
                onClick={() => setScenario('scale-test')}
                data-active={scenario === 'scale-test'}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 data-[active=true]:border-slate-400 data-[active=true]:bg-slate-800 data-[active=true]:text-slate-100"
              >
                Scale-test fixture (Milestone 3, TaskRouter hard-fail)
              </button>
              <button
                type="button"
                onClick={() => setScenario('single-component')}
                data-active={scenario === 'single-component'}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 data-[active=true]:border-slate-400 data-[active=true]:bg-slate-800 data-[active=true]:text-slate-100"
              >
                Single-component fixture (build-failure retry)
              </button>
            </div>
            <span className="rounded border border-amber-700/50 bg-amber-950/20 px-2 py-1 text-[11px] text-amber-300">
              Hand-built ProjectSchema mock (src/types/project-schema.ts) — no orchestrator run
              produced it.
            </span>
          </>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {mode === 'mock' ? (
          <>
            <div className="min-h-0 flex-1">
              <WorkflowGraph key={scenario} schema={mockSchema} />
            </div>
            <GenerateApplicationPanel key={mockSchema.sessionId} schema={mockSchema} />
          </>
        ) : (
          <LiveWorkflow key={loadedSession?.id ?? 'fresh'} initialSession={loadedSession} />
        )}
      </div>
    </div>
  );
}

type LiveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'in-flight'; readonly status: WorkflowJobStatus }
  | { readonly kind: 'succeeded'; readonly result: WorkflowJobResult }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Sized for the slower of the two measured providers, not the average —
 * ADR-002 records the local model at 10.7-27s with zero concurrency
 * handling, against Gemini's 3-16s. A spinner that looks stuck past ~10s
 * would read as broken for a perfectly normal local-model request.
 */
const SLOW_PROVIDER_HINT_MS = 12_000;

interface LiveWorkflowProps {
  /** A previously-saved session opened from the Sidebar, or null for a fresh, empty view. */
  readonly initialSession: WorkflowSessionDetail | null;
}

function LiveWorkflow({ initialSession }: LiveWorkflowProps): JSX.Element {
  const notifySessionSaved = useWorkspaceStore((state) => state.notifySessionSaved);
  const [prompt, setPrompt] = useState('');
  const [state, setState] = useState<LiveState>(() =>
    initialSession === null
      ? { kind: 'idle' }
      : {
          kind: 'succeeded',
          result: {
            schema: initialSession.schema,
            prohibitions: initialSession.prohibitions,
            permissions: initialSession.permissions,
          },
        },
  );
  const [elapsedMs, setElapsedMs] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (state.kind !== 'in-flight') return;
    const startedAt = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
    return () => clearInterval(timer);
  }, [state.kind]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (prompt.trim() === '') return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ kind: 'in-flight', status: 'pending' });
    try {
      const job = await generateProjectSchemaViaApi(prompt, {
        signal: controller.signal,
        onStatus: (status) => setState({ kind: 'in-flight', status }),
      });
      applyFinishedJob(job, setState);
      // The server persists a session as part of reaching 'succeeded'
      // (workflow-api.ts) — this just tells the Sidebar its cached list is
      // stale, never writes anything itself.
      if (job.status === 'succeeded') notifySessionSaved();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setState({ kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        onSubmit={handleSubmit}
        className="flex flex-shrink-0 gap-2 border-b border-slate-800 bg-slate-950 px-4 py-2"
      >
        <input
          type="text"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the app you want to build..."
          disabled={state.kind === 'in-flight'}
          className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
        />
        <button
          type="submit"
          disabled={state.kind === 'in-flight' || prompt.trim() === ''}
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Generate
        </button>
      </form>

      <div className="min-h-0 flex-1">
        {state.kind === 'idle' && (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">
            Enter a prompt above to generate a real ProjectSchema.
          </div>
        )}

        {state.kind === 'in-flight' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-300">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400" />
            <div>{JOB_STATUS_LABEL[state.status]}</div>
            <div className="text-xs text-slate-500">
              {(elapsedMs / 1000).toFixed(1)}s elapsed
              {elapsedMs > SLOW_PROVIDER_HINT_MS
                ? ' — the local model can take up to ~27s; still working'
                : ''}
            </div>
          </div>
        )}

        {state.kind === 'failed' && (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-md rounded-lg border border-red-700/50 bg-red-950/20 p-4 text-sm">
              <div className="mb-1 font-semibold text-red-300">Generation failed</div>
              <p className="text-red-200">{state.message}</p>
            </div>
          </div>
        )}

        {state.kind === 'succeeded' && (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <WorkflowGraph
                key={state.result.schema.sessionId}
                schema={state.result.schema}
                prohibitions={state.result.prohibitions}
              />
            </div>
            <GenerateApplicationPanel
              key={state.result.schema.sessionId}
              schema={state.result.schema}
            />
          </div>
        )}
      </div>
    </div>
  );
}

const JOB_STATUS_LABEL: Readonly<Record<WorkflowJobStatus, string>> = {
  pending: 'Queued…',
  running: 'Generating…',
  succeeded: 'Done',
  failed: 'Failed',
};

function applyFinishedJob(job: WorkflowJob, setState: (state: LiveState) => void): void {
  if (job.status === 'succeeded' && job.result !== undefined) {
    setState({ kind: 'succeeded', result: job.result });
    return;
  }
  if (job.status === 'failed' && job.error !== undefined) {
    const message =
      job.error.phase === 'generate'
        ? `Generation failed (${job.error.reason}): ${job.error.message}`
        : `Compilation failed: ${job.error.message}`;
    setState({ kind: 'failed', message });
    return;
  }
  // Defensive: the API contract only ever resolves generateProjectSchemaViaApi
  // once the job is 'succeeded' or 'failed', each with its matching field
  // populated. Reaching here means the server sent a terminal status without
  // the payload its own type promises — a real contract violation, not a
  // case to guess around silently.
  setState({
    kind: 'failed',
    message: `job ${job.id} reached status '${job.status}' without a matching result/error payload`,
  });
}
