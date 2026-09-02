import { useEffect, useRef, useState, type FormEvent } from 'react';
import { WorkflowGraph } from './WorkflowGraph';
import { SMALL_PROJECT_SCHEMA, LARGE_PROJECT_SCHEMA } from './workflow-mocks';
import { generateProjectSchemaViaApi } from './workflow-api-client';
import type { WorkflowJob, WorkflowJobResult, WorkflowJobStatus } from './workflow-job-types';

type Scenario = 'small' | 'large';
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
  const mockSchema = scenario === 'small' ? SMALL_PROJECT_SCHEMA : LARGE_PROJECT_SCHEMA;

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
            </div>
            <span className="rounded border border-amber-700/50 bg-amber-950/20 px-2 py-1 text-[11px] text-amber-300">
              Hand-built ProjectSchema mock (src/types/project-schema.ts) — no orchestrator run
              produced it.
            </span>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {mode === 'mock' ? <WorkflowGraph key={scenario} schema={mockSchema} /> : <LiveWorkflow />}
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

function LiveWorkflow(): JSX.Element {
  const [prompt, setPrompt] = useState('');
  const [state, setState] = useState<LiveState>({ kind: 'idle' });
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
          <WorkflowGraph
            key={state.result.schema.sessionId}
            schema={state.result.schema}
            prohibitions={state.result.prohibitions}
          />
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
