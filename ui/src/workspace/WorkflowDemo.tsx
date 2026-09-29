import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Icon } from '../design/Icon';
import { SegmentedControl } from '../design/SegmentedControl';
import { WorkflowGraph } from './WorkflowGraph';
import { GenerateApplicationPanel } from './GenerateApplicationPanel';
import { PlanChangeBar } from './PlanChangeBar';
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
  const openedSession = useWorkspaceStore((state) => state.openedSession);
  // The store keeps the opened session across tab switches (this panel
  // unmounts whenever another tab is shown), so mounting with one already
  // set means "come back to where you were": the live view, that session.
  const [mode, setMode] = useState<Mode>(openedSession === null ? 'mock' : 'live');
  const [scenario, setScenario] = useState<Scenario>('small');
  // Captured into local state rather than read directly from the store:
  // LiveWorkflow's `key` is derived from this value, and a fresh generation
  // inside LiveWorkflow updates the store's copy (rememberSession) - if the
  // key followed the store, that update would remount LiveWorkflow mid-flow.
  const [loadedSession, setLoadedSession] = useState<WorkflowSessionDetail | null>(openedSession);

  // A session opened from the Sidebar always lands on the live view, even if
  // this tab was last left on a mock scenario — reopening a real past run to
  // find it silently replaced by an unrelated hand-built fixture would be a
  // worse surprise than switching modes underneath the user once, here.
  useEffect(() => {
    if (openedSession === null || openedSession.id === loadedSession?.id) return;
    setLoadedSession(openedSession);
    setMode('live');
  }, [openedSession, loadedSession]);

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
      <div className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-white/[0.06] bg-black/10 px-4 py-2.5">
        <SegmentedControl<Mode>
          ariaLabel="Where the schema comes from"
          kind="toggles"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'mock', label: 'Mock data' },
            { value: 'live', label: 'Generate from prompt' },
          ]}
        />

        {mode === 'mock' && (
          <>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setScenario('small')}
                data-active={scenario === 'small'}
                aria-pressed={scenario === 'small'}
                className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-xs font-medium text-slate-400 hover:bg-white/[0.08] hover:text-slate-100 data-[active=true]:border-sky-500/40 data-[active=true]:bg-sky-500/[0.16] data-[active=true]:text-sky-200"
              >
                Small project
              </button>
              <button
                type="button"
                onClick={() => setScenario('large')}
                data-active={scenario === 'large'}
                aria-pressed={scenario === 'large'}
                className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-xs font-medium text-slate-400 hover:bg-white/[0.08] hover:text-slate-100 data-[active=true]:border-sky-500/40 data-[active=true]:bg-sky-500/[0.16] data-[active=true]:text-sky-200"
              >
                Large project (350-component scale test)
              </button>
              <button
                type="button"
                onClick={() => setScenario('tension')}
                data-active={scenario === 'tension'}
                aria-pressed={scenario === 'tension'}
                className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-xs font-medium text-slate-400 hover:bg-white/[0.08] hover:text-slate-100 data-[active=true]:border-sky-500/40 data-[active=true]:bg-sky-500/[0.16] data-[active=true]:text-sky-200"
              >
                Known-tension fixture (Milestone 1)
              </button>
              <button
                type="button"
                onClick={() => setScenario('scale-test')}
                data-active={scenario === 'scale-test'}
                aria-pressed={scenario === 'scale-test'}
                className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-xs font-medium text-slate-400 hover:bg-white/[0.08] hover:text-slate-100 data-[active=true]:border-sky-500/40 data-[active=true]:bg-sky-500/[0.16] data-[active=true]:text-sky-200"
              >
                Scale-test fixture (Milestone 3, TaskRouter hard-fail)
              </button>
              <button
                type="button"
                onClick={() => setScenario('single-component')}
                data-active={scenario === 'single-component'}
                aria-pressed={scenario === 'single-component'}
                className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-xs font-medium text-slate-400 hover:bg-white/[0.08] hover:text-slate-100 data-[active=true]:border-sky-500/40 data-[active=true]:bg-sky-500/[0.16] data-[active=true]:text-sky-200"
              >
                Single-component fixture (build-failure retry)
              </button>
            </div>
            <span className="rounded-full bg-amber-500/[0.12] px-2.5 py-1 text-[11px] text-amber-300">
              Hand-built ProjectSchema mock (src/types/project-schema.ts) — no orchestrator run
              produced it.
            </span>
          </>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {mode === 'mock' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <GraphFrame>
              <WorkflowGraph key={scenario} schema={mockSchema} />
            </GraphFrame>
            <GenerateApplicationPanel key={mockSchema.sessionId} schema={mockSchema} />
          </div>
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
  const rememberSession = useWorkspaceStore((state) => state.rememberSession);
  const [prompt, setPrompt] = useState(initialSession?.prompt ?? '');
  // Bumped on every revised plan so the graph and the generate panel start
  // fresh - a revision keeps the session id, so the id alone cannot tell them.
  const [planVersion, setPlanVersion] = useState(0);
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
      recordSucceeded(job);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setState({ kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  // The server persists a session as part of reaching 'succeeded'
  // (workflow-api.ts) — this just tells the Sidebar its cached list is
  // stale, never writes anything itself.
  function recordSucceeded(job: WorkflowJob): void {
    if (job.status !== 'succeeded' || job.result === undefined) return;
    notifySessionSaved();
    rememberSession({
      id: job.result.schema.sessionId,
      title: job.result.schema.title,
      prompt: job.prompt,
      createdAt: job.createdAt,
      schema: job.result.schema,
      prohibitions: job.result.prohibitions,
      permissions: job.result.permissions,
    });
  }

  /**
   * Re-plans the shown session with one change. The current plan stays on
   * screen until the new one arrives; a failure leaves it untouched and is
   * reported in the change bar, not over the plan.
   */
  async function handleRevise(sessionId: string, change: string): Promise<string | null> {
    try {
      const job = await generateProjectSchemaViaApi({ revises: sessionId, change });
      if (job.status !== 'succeeded' || job.result === undefined) {
        return job.error === undefined ? `job ended as ${job.status}` : job.error.message;
      }
      setState({ kind: 'succeeded', result: job.result });
      setPrompt(job.prompt);
      setPlanVersion((version) => version + 1);
      recordSucceeded(job);
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        onSubmit={handleSubmit}
        className="flex flex-shrink-0 items-start gap-2 border-b border-white/[0.06] px-4 py-3"
      >
        {/* A textarea, not an input: a revised prompt keeps its "Changes to the plan" list on separate lines. */}
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Describe the app you want to build..."
          disabled={state.kind === 'in-flight'}
          rows={Math.min(6, prompt.split('\n').length)}
          className="focus-glow min-w-0 flex-1 resize-none rounded-xl border border-white/[0.08] bg-black/25 px-3.5 py-2 text-[13px] leading-relaxed text-slate-100 placeholder:text-slate-500 focus-visible:outline-none"
        />
        <button type="submit" disabled={state.kind === 'in-flight' || prompt.trim() === ''} className="btn btn-primary self-start">
          <Icon name="sparkles" size={14} />
          Generate
        </button>
      </form>

      <div className="min-h-0 flex-1">
        {state.kind === 'idle' && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.03] text-violet-300">
              <Icon name="flow" size={22} />
            </span>
            <p className="text-sm text-slate-400">Enter a prompt above to generate a real ProjectSchema.</p>
            <p className="max-w-sm text-xs text-slate-500">The plan appears here as a graph - pages, API, data and security, and the rules between them.</p>
          </div>
        )}

        {state.kind === 'in-flight' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-300">
            <span className="spinner !h-7 !w-7 !border-[2.5px]" />
            <div className="mt-1 font-medium">{JOB_STATUS_LABEL[state.status]}</div>
            <div className="text-xs text-slate-500">
              {(elapsedMs / 1000).toFixed(1)}s elapsed
              {elapsedMs > SLOW_PROVIDER_HINT_MS
                ? ' — still working; a local model on a small free GPU can take a few minutes for a plan'
                : ''}
            </div>
          </div>
        )}

        {state.kind === 'failed' && (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-md rounded-2xl border border-red-400/25 bg-red-500/[0.07] p-4 text-sm">
              <div className="mb-1 font-semibold text-red-300">Generation failed</div>
              <p className="text-red-200">{state.message}</p>
            </div>
          </div>
        )}

        {state.kind === 'succeeded' && (
          <div className="h-full min-h-0 overflow-y-auto">
            <GraphFrame>
              <WorkflowGraph
                key={`${state.result.schema.sessionId}:${planVersion}`}
                schema={state.result.schema}
                prohibitions={state.result.prohibitions}
                demoControls={false}
              />
            </GraphFrame>
            <div className="mx-4 mt-3 overflow-hidden rounded-2xl border border-violet-400/[0.14] bg-violet-500/[0.04]">
              <PlanChangeBar onRevise={(change) => handleRevise(state.result.schema.sessionId, change)} />
            </div>
            <GenerateApplicationPanel
              key={`${state.result.schema.sessionId}:${planVersion}`}
              schema={state.result.schema}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The graph's own frame: a fixed, generous height, so the plan is always
 * fully visible and the results below scroll instead of squeezing it.
 */
function GraphFrame({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="mx-4 mt-4 h-[clamp(420px,58vh,680px)] overflow-hidden rounded-2xl border border-white/[0.07] bg-black/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      {children}
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
