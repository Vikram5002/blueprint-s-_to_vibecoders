import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  runAgent,
  stepsFor,
  type AgentOutcome,
  type ReviewDecision,
  type StepId,
  type StepStatus,
} from './agent-runner';
import { AgentRunCard, type AgentRunView } from './AgentRunCard';
import { Composer } from './Composer';
import { STARTER_IDEAS } from './starter-ideas';
import {
  continueApplicationViaApi,
  fetchRunPages,
  generateApplicationViaApi,
  generateProjectSchemaViaApi,
  repairApplicationViaApi,
} from './workflow-api-client';
import { useWorkspaceStore } from './store';
import { Icon } from '../design/Icon';
import { LogoMark } from '../design/Logo';
import type { ProjectSchema } from './project-schema-types';
import type { WorkflowJob } from './workflow-job-types';

interface Run extends AgentRunView {
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
 * Agent mode: describe the application, and the tool plans it, stops for the
 * person to review the plan (unless they turned that off), then generates
 * it, builds it, fixes what fails and prepares its pages - step by step, with
 * a live timeline and a Stop button (agent-runner.ts holds the decisions).
 *
 * An empty page is a hero with the composer in the middle and starter ideas
 * below it; once a run exists, the runs scroll and the composer docks at the
 * bottom.
 */
export function ConversationPane(): JSX.Element {
  const openSession = useWorkspaceStore((state) => state.openSession);
  const openPageInBuilder = useWorkspaceStore((state) => state.openPageInBuilder);
  const notifySessionSaved = useWorkspaceStore((state) => state.notifySessionSaved);
  const notifyRunSaved = useWorkspaceStore((state) => state.notifyRunSaved);
  const newProjectVersion = useWorkspaceStore((state) => state.newProjectVersion);
  const [prompt, setPrompt] = useState('');
  const [runs, setRuns] = useState<readonly Run[]>([]);
  const [now, setNow] = useState(Date.now());
  const [reviewFirst, setReviewFirst] = useState(readReviewFirst);
  const abortRef = useRef<AbortController | null>(null);
  const decideRef = useRef<((decision: ReviewDecision) => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const running = runs.some((run) => run.finishedAt === null);

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);

  // The browser tab says what the agent is doing, so a person on another tab can tell at a glance.
  const lastForTitle = runs[runs.length - 1];
  const tabTitle =
    lastForTitle === undefined || lastForTitle.finishedAt !== null
      ? 'VibeCoder'
      : lastForTitle.review !== null
        ? '● Review the plan - VibeCoder'
        : `● ${lastForTitle.steps.find((step) => step.status === 'running')?.title ?? 'Working'} - VibeCoder`;
  useEffect(() => {
    document.title = tabTitle;
  }, [tabTitle]);
  useEffect(() => () => void (document.title = 'VibeCoder'), []);

  // "New project": a clean page, unless a run is still going (it is never thrown away mid-flight).
  useEffect(() => {
    if (newProjectVersion === 0) return;
    setRuns((current) => (current.some((run) => run.finishedAt === null) ? current : []));
    setPrompt('');
  }, [newProjectVersion]);

  // Follow the newest run as it grows, smoothly, like a conversation.
  const lastRun = runs[runs.length - 1];
  const lastRunSignature =
    lastRun === undefined
      ? ''
      : `${runs.length}:${lastRun.steps.map((step) => step.status).join(',')}:${lastRun.review === null ? 0 : 1}:${lastRun.finishedAt ?? 0}`;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller !== null) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  }, [lastRunSignature]);

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
      {
        prompt: request,
        steps: stepsFor(reviewFirst),
        startedAt: Date.now(),
        finishedAt: null,
        outcome: null,
        error: null,
        review: null,
      },
    ]);
    const update = (id: StepId, status: StepStatus, detail: string): void =>
      updateLast((run) => ({
        ...run,
        steps: run.steps.map((step) => (step.id === id ? { ...step, status, detail } : step)),
      }));
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
          generate: (schema, signal, onStatus) =>
            generateApplicationViaApi(schema, { signal, onStatus }),
          continueRun: (jobId, signal, onStatus) =>
            continueApplicationViaApi(jobId, { signal, onStatus }),
          repair: (jobId, signal, onStatus) =>
            repairApplicationViaApi(jobId, '', { signal, onStatus }),
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
        review: null,
        error: stopped
          ? 'Stopped. Anything already generated is saved - open the project to continue from there.'
          : cause instanceof Error
            ? cause.message
            : String(cause),
        steps: run.steps.map((step) =>
          step.status === 'running'
            ? { ...step, status: 'failed' as const, detail: stopped ? 'stopped' : step.detail }
            : step,
        ),
      }));
    }
  }

  /** Re-plans the plan under review with one change (the same revision the Workflow tab uses). */
  async function reviseReview(sessionId: string, change: string): Promise<string | null> {
    try {
      const job = await generateProjectSchemaViaApi({ revises: sessionId, change });
      const result = job.result;
      if (job.status !== 'succeeded' || result === undefined)
        return job.error?.message ?? `job ended as ${job.status}`;
      updateLast((run) => ({ ...run, review: { schema: result.schema, workflowJob: job } }));
      notifySessionSaved();
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  }

  function approve(): void {
    const pending = runs[runs.length - 1]?.review;
    if (pending != null)
      decideRef.current?.({
        kind: 'approve',
        schema: pending.schema,
        workflowJob: pending.workflowJob,
      });
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

  function editPages(outcome: AgentOutcome): void {
    const firstPage = outcome.pages[0];
    if (firstPage === undefined || outcome.job === null || outcome.schema === null) return;
    openPageInBuilder(
      {
        runId: outcome.job.id,
        sessionId: outcome.schema.sessionId,
        sessionTitle: outcome.schema.title,
        path: firstPage.path,
        edited: firstPage.edited,
      },
      firstPage.layout,
    );
  }

  const composer = (variant: 'hero' | 'dock'): JSX.Element => (
    <Composer
      variant={variant}
      value={prompt}
      onChange={setPrompt}
      onSubmit={() => void start()}
      running={running}
      onStop={stop}
      reviewFirst={reviewFirst}
      onReviewFirst={toggleReviewFirst}
      focusKey={newProjectVersion}
    />
  );

  if (runs.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AgentHero composer={composer('hero')} onIdea={setPrompt} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 pb-10 pt-8">
        <div className="mx-auto max-w-3xl space-y-8">
          {runs.map((run, index) => (
            <AgentRunCard
              key={index}
              run={run}
              now={now}
              onRevise={reviseReview}
              onApprove={approve}
              onCancel={() => decideRef.current?.({ kind: 'cancel' })}
              onOpen={openResult}
              onEditPages={editPages}
            />
          ))}
        </div>
      </div>
      <div className="relative flex-shrink-0 px-6 pb-5 pt-2">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-10 h-10 bg-gradient-to-t from-[#0c0c0e] to-transparent"
        />
        <div className="mx-auto max-w-3xl">{composer('dock')}</div>
      </div>
    </div>
  );
}

function AgentHero({
  composer,
  onIdea,
}: {
  readonly composer: JSX.Element;
  readonly onIdea: (prompt: string) => void;
}): JSX.Element {
  const at = (index: number): CSSProperties => ({ '--i': index }) as CSSProperties;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 pb-16 pt-[9vh] text-center">
      <div className="stagger relative mb-6" style={at(0)}>
        <span className="halo" />
        <LogoMark size={54} className="relative drop-shadow-[0_12px_30px_rgba(109,106,248,0.55)]" />
      </div>
      <span
        className="stagger mb-4 inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-[11.5px] font-medium text-slate-300"
        style={at(1)}
      >
        <Icon name="sparkles" size={12} className="text-violet-300" />
        Agent mode
      </span>
      <h1
        className="stagger gradient-text text-[34px] font-semibold leading-[1.12] tracking-[-0.035em] sm:text-[42px]"
        style={at(2)}
      >
        What will you build today?
      </h1>
      <p
        className="stagger mt-3.5 max-w-xl text-[15px] leading-relaxed text-slate-400"
        style={at(3)}
      >
        Describe an app in plain words. VibeCoder plans it, lets you change the plan, then builds,
        checks and fixes it - on its own.
      </p>
      <div className="stagger mt-9 w-full" style={at(4)}>
        {composer}
      </div>
      <div className="mt-10 w-full">
        <div
          className="stagger mb-3 flex items-center gap-2 text-left text-xs font-medium text-slate-500"
          style={at(5)}
        >
          <span className="h-px flex-1 bg-gradient-to-r from-transparent to-white/[0.08]" />
          Start from an idea
          <span className="h-px flex-1 bg-gradient-to-l from-transparent to-white/[0.08]" />
        </div>
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {STARTER_IDEAS.map((idea, index) => (
            <button
              key={idea.label}
              type="button"
              data-testid="starter-idea"
              onClick={() => onIdea(idea.prompt)}
              title={idea.prompt}
              style={at(6 + index)}
              className="stagger card card-hover group flex flex-col items-start gap-2 !rounded-2xl p-3.5 text-left"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.06] text-slate-300 transition-colors duration-300 group-hover:bg-violet-500/[0.18] group-hover:text-violet-200">
                <Icon name={idea.icon} size={15} />
              </span>
              <span className="text-[13px] font-medium text-slate-100">{idea.label}</span>
              <span className="text-[11.5px] leading-snug text-slate-500">{idea.blurb}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
