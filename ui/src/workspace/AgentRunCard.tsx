import { Icon } from '../design/Icon';
import { LogoMark } from '../design/Logo';
import { PlanReview } from './PlanReview';
import { PACK_NOTE } from './GenerateApplicationPanel';
import { applicationJobDownloadUrl } from './workflow-api-client';
import type { AgentOutcome, AgentStep, StepStatus } from './agent-runner';
import type { ProjectSchema } from './project-schema-types';

export interface AgentRunView {
  readonly prompt: string;
  readonly steps: readonly AgentStep[];
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly outcome: AgentOutcome | null;
  readonly error: string | null;
  readonly review: { readonly schema: ProjectSchema } | null;
}

interface AgentRunCardProps {
  readonly run: AgentRunView;
  readonly now: number;
  readonly onRevise: (sessionId: string, change: string) => Promise<string | null>;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
  readonly onOpen: (outcome: AgentOutcome) => void;
  readonly onEditPages: (outcome: AgentOutcome) => void;
}

const SETTLED: ReadonlySet<StepStatus> = new Set(['done', 'failed', 'skipped']);

function headline(run: AgentRunView): { readonly text: string; readonly tone: string } {
  if (run.finishedAt === null) {
    return run.review !== null
      ? { text: 'Waiting for your review', tone: 'text-violet-300' }
      : { text: 'Working', tone: 'text-sky-300' };
  }
  if (run.error !== null) return { text: 'Stopped', tone: 'text-amber-300' };
  return run.steps.some((step) => step.status === 'failed')
    ? { text: 'Finished with issues', tone: 'text-amber-300' }
    : { text: 'Finished', tone: 'text-emerald-300' };
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  return `${Math.floor(seconds / 60)}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`;
}

/** One request and what the agent did with it: the request, a live timeline, the review stop, and the results. */
export function AgentRunCard({
  run,
  now,
  onRevise,
  onApprove,
  onCancel,
  onOpen,
  onEditPages,
}: AgentRunCardProps): JSX.Element {
  const live = run.finishedAt === null;
  const elapsed = ((run.finishedAt ?? now) - run.startedAt) / 1000;
  const settled = run.steps.filter((step) => SETTLED.has(step.status)).length;
  const progress = Math.max(0.04, settled / run.steps.length);
  const state = headline(run);
  const outcome = run.outcome;

  return (
    <div data-testid="agent-run" className="anim-view space-y-3">
      <div className="ml-auto w-fit max-w-[82%] rounded-[20px] rounded-br-md bg-gradient-to-br from-[#7b72ff] to-[#1e7cf5] px-4 py-2.5 text-[14px] leading-relaxed text-white shadow-[0_12px_30px_-14px_rgba(80,110,255,0.8)]">
        {run.prompt}
      </div>

      <div className="card overflow-hidden">
        <div className="relative h-[2px] bg-white/[0.04]">
          <div
            className="progress-line absolute inset-y-0 left-0"
            data-live={live && run.review === null}
            style={{ width: `${(live ? progress : 1) * 100}%` }}
          />
        </div>
        <div className="flex items-center gap-2.5 px-4 pb-1 pt-3.5">
          <LogoMark size={22} />
          <span className="text-[13px] font-semibold text-slate-100">VibeCoder</span>
          <span className={`flex items-center gap-1.5 text-xs font-medium ${state.tone}`}>
            {live && run.review === null && (
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-current" />
            )}
            {state.text}
          </span>
          <span className="ml-auto flex items-center gap-1 font-mono text-xs tabular-nums text-slate-500">
            <Icon name="clock" size={12} />
            {formatElapsed(elapsed)}
          </span>
        </div>

        <ol className="px-4 pb-4 pt-3">
          {run.steps.map((step, index) => (
            <li
              key={step.id}
              data-testid={`agent-step-${step.id}`}
              data-status={step.status}
              className="relative flex gap-3 pb-3.5 last:pb-0"
            >
              {index < run.steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={`absolute bottom-0 left-[10px] top-[24px] w-px ${SETTLED.has(step.status) ? 'bg-white/[0.12]' : 'bg-white/[0.06]'}`}
                />
              )}
              <StepIcon status={step.status} />
              <div className="min-w-0 flex-1 pt-[1px]">
                <div
                  className={`text-[13.5px] ${step.status === 'waiting' ? 'text-slate-500' : step.status === 'running' ? 'font-medium text-slate-50' : 'text-slate-200'}`}
                >
                  {step.title}
                </div>
                {step.detail !== '' && (
                  <div title={step.detail} className="mt-0.5 truncate text-xs text-slate-500">
                    {step.detail}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>

        {run.review !== null && live && (
          <div className="px-4 pb-4">
            <PlanReview
              schema={run.review.schema}
              onRevise={(change) => onRevise(run.review?.schema.sessionId ?? '', change)}
              onApprove={onApprove}
              onCancel={onCancel}
            />
          </div>
        )}

        {run.error !== null && (
          <p className="mx-4 mb-4 flex gap-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-xs leading-relaxed text-amber-200">
            <Icon name="clock" size={14} className="mt-px flex-shrink-0" />
            {run.error}
          </p>
        )}

        {outcome?.job != null && outcome.schema !== null && (
          <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] bg-white/[0.015] px-4 py-3">
            <button
              type="button"
              data-testid="agent-open"
              onClick={() => onOpen(outcome)}
              className="btn btn-secondary btn-sm"
            >
              <Icon name="flow" size={14} />
              Open in Workflow
            </button>
            {outcome.pages.length > 0 && (
              <button
                type="button"
                onClick={() => onEditPages(outcome)}
                className="btn btn-secondary btn-sm"
              >
                <Icon name="layout" size={14} />
                Edit pages
              </button>
            )}
            <a
              href={applicationJobDownloadUrl(outcome.job.id)}
              title={PACK_NOTE}
              className="btn btn-primary btn-sm ml-auto"
            >
              <Icon name="download" size={14} />
              Download (.zip + project report)
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function StepIcon({ status }: { readonly status: StepStatus }): JSX.Element {
  const base =
    'relative z-[1] flex h-[21px] w-[21px] flex-shrink-0 items-center justify-center rounded-full';
  if (status === 'running') {
    return (
      <span className={`${base} bg-[#141417]`}>
        <span className="spinner !h-[17px] !w-[17px]" />
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span className={`${base} bg-emerald-500/[0.16] text-emerald-300 ring-1 ring-emerald-400/30`}>
        <Icon name="check" size={12} strokeWidth={2.6} />
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className={`${base} bg-red-500/[0.16] text-red-300 ring-1 ring-red-400/30`}>
        <Icon name="x" size={11} strokeWidth={2.6} />
      </span>
    );
  }
  if (status === 'skipped') {
    return (
      <span className={`${base} bg-white/[0.04] text-slate-500`}>
        <Icon name="minus" size={11} strokeWidth={2.4} />
      </span>
    );
  }
  return <span className={`${base} bg-[#141417] ring-1 ring-inset ring-white/[0.14]`} />;
}
