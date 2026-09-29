import { useEffect, useRef, useState } from 'react';
import { runAgent, stepsFor, type AgentOutcome, type AgentStep, type ReviewDecision, type StepId, type StepStatus } from './agent-runner';
import { PlanReview } from './PlanReview';
import { PACK_NOTE } from './GenerateApplicationPanel';
import { STARTER_IDEAS } from './starter-ideas';
import type { ProjectSchema } from './project-schema-types';
import type { WorkflowJob } from './workflow-job-types';
import {
  applicationJobDownloadUrl,
  continueApplicationViaApi,
  fetchRunPages,
  generateApplicationViaApi,
  generateProjectSchemaViaApi,
  repairApplicationViaApi,
} from './workflow-api-client';
import { useWorkspaceStore } from './store';

const STATUS_ICON: Record<StepStatus, string> = { waiting: '○', running: '◌', done: '✓', failed: '✕', skipped: '–' };
const STATUS_TONE: Record<StepStatus, string> = {
  waiting: 'text-slate-500',
  running: 'text-sky-300',
  done: 'text-emerald-300',
  failed: 'text-red-300',
  skipped: 'text-slate-500',
};

interface Run {
  readonly prompt: string;
  readonly steps: readonly AgentStep[];
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly outcome: AgentOutcome | null;
  readonly error: string | null;
  /** The plan waiting for the person's decision, while the agent is stopped at the review. */
  readonly review: { readonly schema: ProjectSchema; readonly workflowJob: WorkflowJob } | null;
}

/** Remembered per browser; a missing or blocked storage just means the default (review first). */
const REVIEW_FIRST_KEY = 'vibe.agent.reviewFirst';

function readReviewFirst(): boolean {
  try {
    return window.localStorage.getItem(REVIEW_FIRST_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeReviewFirst(value: boolean): void {
  try {
    window.localStorage.setItem(REVIEW_FIRST_KEY, String(value));
  } catch {
    // Not remembered - the choice still applies to this session.
  }
}

/**
 * Agent mode: describe the application, and the tool plans it, generates it,
 * builds it, fixes what fails and prepares its pages - by itself, step by
 * step, with a live timeline and a Stop button (agent-runner.ts).
 */
export function ConversationPane(): JSX.Element {
  const openSession = useWorkspaceStore((state) => state.openSession);
  const openPageInBuilder = useWorkspaceStore((state) => state.openPageInBuilder);
  const notifySessionSaved = useWorkspaceStore((state) => state.notifySessionSaved);
  const notifyRunSaved = useWorkspaceStore((state) => state.notifyRunSaved);
  const [prompt, setPrompt] = useState('');
  const [runs, setRuns] = useState<readonly Run[]>([]);
  const [now, setNow] = useState(Date.now());
  const [reviewFirst, setReviewFirst] = useState(readReviewFirst);
  const abortRef = useRef<AbortController | null>(null);
  const decideRef = useRef<((decision: ReviewDecision) => void) | null>(null);
  const running = runs.some((run) => run.finishedAt === null);

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);

  function updateLast(change: (run: Run) => Run): void {
    setRuns((current) => current.map((run, i) => (i === current.length - 1 ? change(run) : run)));
  }

  async function start(): Promise<void> {
    const request = prompt.trim();
    if (request === '' || running) return;
    setPrompt('');
    const controller = new AbortController();
    abortRef.current = controller;
    setRuns((current) => [
      ...current,
      { prompt: request, steps: stepsFor(reviewFirst), startedAt: Date.now(), finishedAt: null, outcome: null, error: null, review: null },
    ]);
    const update = (id: StepId, status: StepStatus, detail: string): void =>
      updateLast((run) => ({ ...run, steps: run.steps.map((step) => (step.id === id ? { ...step, status, detail } : step)) }));
    // Resolved by "Build this plan", "Cancel" or Stop - whichever comes first.
    const review = (schema: ProjectSchema, workflowJob: WorkflowJob): Promise<ReviewDecision> =>
      new Promise((resolve) => {
        updateLast((run) => ({ ...run, review: { schema, workflowJob } }));
        decideRef.current = (decision) => {
          decideRef.current = null;
          updateLast((run) => ({ ...run, review: null }));
          resolve(decision);
        };
      });
    try {
      const outcome = await runAgent(
        request,
        {
          plan: (p, signal, onStatus) => generateProjectSchemaViaApi(p, { signal, onStatus }),
          generate: (schema, signal, onStatus) => generateApplicationViaApi(schema, { signal, onStatus }),
          continueRun: (jobId, signal, onStatus) => continueApplicationViaApi(jobId, { signal, onStatus }),
          repair: (jobId, signal, onStatus) => repairApplicationViaApi(jobId, '', { signal, onStatus }),
          pages: fetchRunPages,
        },
        update,
        controller.signal,
        reviewFirst ? { review } : {},
      );
      notifySessionSaved();
      notifyRunSaved();
      updateLast((run) => ({ ...run, outcome, finishedAt: Date.now() }));
    } catch (cause) {
      const stopped = cause instanceof DOMException && cause.name === 'AbortError';
      updateLast((run) => ({
        ...run,
        finishedAt: Date.now(),
        error: stopped ? 'Stopped. Anything already generated is saved - open the session to continue from there.' : cause instanceof Error ? cause.message : String(cause),
        steps: run.steps.map((step) => (step.status === 'running' ? { ...step, status: 'failed' as const, detail: stopped ? 'stopped' : step.detail } : step)),
      }));
    }
  }

  /** Re-plans the plan under review with one change (the same revision the Workflow tab uses). */
  async function reviseReview(sessionId: string, change: string): Promise<string | null> {
    try {
      const job = await generateProjectSchemaViaApi({ revises: sessionId, change });
      const result = job.result;
      if (job.status !== 'succeeded' || result === undefined) return job.error?.message ?? `job ended as ${job.status}`;
      updateLast((run) => ({ ...run, review: { schema: result.schema, workflowJob: job } }));
      notifySessionSaved();
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  }

  function stop(): void {
    abortRef.current?.abort();
    decideRef.current?.({ kind: 'cancel' });
  }

  function toggleReviewFirst(value: boolean): void {
    setReviewFirst(value);
    writeReviewFirst(value);
  }

  function openResult(outcome: AgentOutcome): void {
    const workflow = outcome.workflowJob;
    if (outcome.schema === null || workflow?.result === undefined) return;
    openSession({
      id: outcome.schema.sessionId,
      title: outcome.schema.title,
      prompt: workflow.prompt,
      createdAt: workflow.createdAt,
      schema: workflow.result.schema,
      prohibitions: workflow.result.prohibitions,
      permissions: workflow.result.permissions,
    });
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto px-6 py-6">
        {runs.length === 0 && (
          <div className="mx-auto max-w-xl pt-16 text-center">
            <div className="text-lg font-semibold text-slate-100">Agent mode</div>
            <p className="mt-2 text-sm text-slate-400">
              Describe the application you want. The agent plans it, generates it, builds it, fixes what fails and prepares its pages -
              step by step, on its own. You can stop it at any time; whatever it finished is kept.
            </p>
            <div className="mt-6 text-xs font-medium uppercase tracking-wider text-slate-500">Start from an idea</div>
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              {STARTER_IDEAS.map((idea) => (
                <button
                  key={idea.label}
                  type="button"
                  data-testid="starter-idea"
                  onClick={() => setPrompt(idea.prompt)}
                  title={idea.prompt}
                  className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-xs text-slate-300 hover:border-sky-600 hover:text-sky-200"
                >
                  {idea.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {runs.map((run, index) => {
          const elapsed = ((run.finishedAt ?? now) - run.startedAt) / 1000;
          const outcome = run.outcome;
          const firstPage = outcome?.pages[0];
          return (
            <div key={index} data-testid="agent-run" className="mx-auto max-w-3xl space-y-2">
              <div className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-sm bg-sky-600/80 px-4 py-2 text-sm text-white">{run.prompt}</div>
              <div className="rounded-2xl rounded-bl-sm border border-slate-800 bg-slate-900/70 p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
                  <span>{run.finishedAt === null ? 'Working…' : run.error !== null ? 'Stopped' : 'Finished'}</span>
                  <span className="font-mono">{elapsed.toFixed(0)}s</span>
                </div>
                <ol className="space-y-1.5">
                  {run.steps.map((step) => (
                    <li key={step.id} data-testid={`agent-step-${step.id}`} data-status={step.status} className="flex gap-2 text-sm">
                      <span className={`w-4 shrink-0 text-center ${STATUS_TONE[step.status]} ${step.status === 'running' ? 'animate-pulse' : ''}`}>{STATUS_ICON[step.status]}</span>
                      <span className={step.status === 'waiting' ? 'text-slate-500' : 'text-slate-200'}>{step.title}</span>
                      {step.detail !== '' && <span className="truncate text-xs leading-5 text-slate-500">{step.detail}</span>}
                    </li>
                  ))}
                </ol>
                {run.review !== null && run.finishedAt === null && (
                  <PlanReview
                    schema={run.review.schema}
                    onRevise={(change) => reviseReview(run.review?.schema.sessionId ?? '', change)}
                    onApprove={() => {
                      if (run.review !== null) decideRef.current?.({ kind: 'approve', schema: run.review.schema, workflowJob: run.review.workflowJob });
                    }}
                    onCancel={() => decideRef.current?.({ kind: 'cancel' })}
                  />
                )}
                {run.error !== null && <p className="mt-2 text-xs text-amber-300">{run.error}</p>}
                {outcome?.job != null && outcome.schema !== null && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" data-testid="agent-open" onClick={() => openResult(outcome)} className="rounded-md border border-sky-700 bg-sky-950/40 px-3 py-1 text-xs text-sky-200 hover:bg-sky-900/40">
                      Open in Workflow
                    </button>
                    {firstPage !== undefined && outcome.job !== null && (
                      <button
                        type="button"
                        onClick={() =>
                          openPageInBuilder(
                            { runId: outcome.job?.id ?? '', sessionId: outcome.schema?.sessionId ?? '', sessionTitle: outcome.schema?.title ?? '', path: firstPage.path, edited: firstPage.edited },
                            firstPage.layout,
                          )
                        }
                        className="rounded-md border border-violet-700 bg-violet-950/40 px-3 py-1 text-xs text-violet-200 hover:bg-violet-900/40"
                      >
                        Edit pages
                      </button>
                    )}
                    <a
                      href={applicationJobDownloadUrl(outcome.job.id)}
                      title={PACK_NOTE}
                      className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
                    >
                      Download (.zip + project report)
                    </a>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t border-slate-800 p-4">
        <label className="mx-auto mb-2 flex max-w-3xl items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            data-testid="agent-review-first"
            checked={reviewFirst}
            disabled={running}
            onChange={(event) => toggleReviewFirst(event.target.checked)}
            className="accent-sky-500"
          />
          Let me review the plan before it is built
        </label>
        <div className="mx-auto flex max-w-3xl gap-2">
          <textarea
            data-testid="agent-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void start();
              }
            }}
            rows={2}
            placeholder="e.g. A booking site for a small yoga studio, with class schedules, sign-up and an admin page"
            className="flex-1 resize-none rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
          />
          {running ? (
            <button type="button" data-testid="agent-stop" onClick={stop} className="rounded-xl border border-red-700 bg-red-950/40 px-4 text-sm text-red-200 hover:bg-red-900/40">
              Stop
            </button>
          ) : (
            <button type="button" data-testid="agent-start" onClick={() => void start()} disabled={prompt.trim() === ''} className="rounded-xl border border-emerald-700 bg-emerald-950/40 px-4 text-sm text-emerald-200 hover:bg-emerald-900/40 disabled:opacity-40">
              Build it
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
