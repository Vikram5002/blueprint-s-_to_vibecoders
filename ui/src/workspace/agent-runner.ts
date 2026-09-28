/**
 * Agent mode (Manus-style): one request, and the tool runs the whole pipeline
 * by itself - plan, generate the application, build, fix what fails, continue
 * if a run stops halfway - reporting each step as it goes.
 *
 * Only orchestration lives here: every step is an existing, separately tested
 * API call, injected so the decisions (when to fix, when to continue, when to
 * give up) are unit-testable without a server. Nothing here writes code.
 */
import type { ApplicationJob } from './application-job-types';
import type { WorkflowJob } from './workflow-job-types';
import type { ProjectSchema } from './project-schema-types';
import type { RunPage } from './workflow-api-client';

export type StepStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
export type StepId = 'plan' | 'generate' | 'continue' | 'fix' | 'pages';

export interface AgentStep {
  readonly id: StepId;
  readonly title: string;
  readonly status: StepStatus;
  readonly detail: string;
}

export interface AgentApis {
  readonly plan: (prompt: string, signal: AbortSignal, onStatus: (status: string) => void) => Promise<WorkflowJob>;
  readonly generate: (schema: ProjectSchema, signal: AbortSignal, onStatus: (job: ApplicationJob) => void) => Promise<ApplicationJob>;
  readonly continueRun: (jobId: string, signal: AbortSignal, onStatus: (job: ApplicationJob) => void) => Promise<ApplicationJob>;
  readonly repair: (jobId: string, signal: AbortSignal, onStatus: (job: ApplicationJob) => void) => Promise<ApplicationJob>;
  readonly pages: (jobId: string) => Promise<readonly RunPage[]>;
}

export interface AgentOutcome {
  readonly schema: ProjectSchema | null;
  readonly job: ApplicationJob | null;
  readonly pages: readonly RunPage[];
  readonly sessionCreatedAt: string | null;
  readonly workflowJob: WorkflowJob | null;
}

export const MAX_FIX_ROUNDS = 2;
export const MAX_CONTINUES = 2;

export const INITIAL_STEPS: readonly AgentStep[] = [
  { id: 'plan', title: 'Plan the application', status: 'waiting', detail: '' },
  { id: 'generate', title: 'Generate, build and check it', status: 'waiting', detail: '' },
  { id: 'continue', title: 'Continue if it stopped halfway', status: 'waiting', detail: '' },
  { id: 'fix', title: 'Fix build errors', status: 'waiting', detail: '' },
  { id: 'pages', title: 'Prepare pages for editing', status: 'waiting', detail: '' },
];

const builds = (job: ApplicationJob): boolean => job.status === 'succeeded' && job.result?.build.installOk === true && job.result.build.buildOk;
const stoppedHalfway = (job: ApplicationJob): boolean => job.status === 'failed' && job.result === undefined && (job.partialFiles?.length ?? 0) > 0;

function failureText(job: ApplicationJob): string {
  const error = job.error;
  if (error === undefined) return 'failed';
  return 'failure' in error ? `${error.component.name}: ${error.failure.message}` : error.message;
}

/** Runs the whole pipeline, reporting every step change through `update`. */
export async function runAgent(prompt: string, apis: AgentApis, update: (id: StepId, status: StepStatus, detail: string) => void, signal: AbortSignal): Promise<AgentOutcome> {
  const empty: AgentOutcome = { schema: null, job: null, pages: [], sessionCreatedAt: null, workflowJob: null };

  update('plan', 'running', 'Reading your request…');
  const planned = await apis.plan(prompt, signal, (status) => update('plan', 'running', status));
  const schema = planned.result?.schema;
  if (planned.status !== 'succeeded' || schema === undefined) {
    update('plan', 'failed', planned.error === undefined ? 'no plan was produced' : JSON.stringify(planned.error).slice(0, 200));
    return { ...empty, workflowJob: planned };
  }
  const counts = (['frontend', 'backend', 'database', 'security'] as const).map((d) => `${schema.domains[d].components.length} ${d}`).join(' · ');
  update('plan', 'done', `${schema.title} - ${counts}`);

  update('generate', 'running', 'Starting…');
  let job = await apis.generate(schema, signal, (j) => update('generate', 'running', j.phase ?? j.status));
  update('generate', job.status === 'succeeded' ? 'done' : 'failed', job.status === 'succeeded' ? 'generated' : failureText(job));

  let continues = 0;
  while (stoppedHalfway(job) && continues < MAX_CONTINUES) {
    continues += 1;
    update('continue', 'running', `Reusing ${job.partialFiles?.length ?? 0} saved components (attempt ${continues})…`);
    job = await apis.continueRun(job.id, signal, (j) => update('continue', 'running', j.phase ?? j.status));
  }
  if (continues === 0) update('continue', 'skipped', 'not needed');
  else update('continue', job.status === 'succeeded' ? 'done' : 'failed', job.status === 'succeeded' ? `finished after ${continues} continue(s)` : failureText(job));
  if (job.status !== 'succeeded') {
    update('fix', 'skipped', 'generation did not finish');
    update('pages', 'skipped', '');
    return { schema, job, pages: [], sessionCreatedAt: planned.createdAt, workflowJob: planned };
  }

  let rounds = 0;
  while (!builds(job) && job.result?.build.installOk === true && rounds < MAX_FIX_ROUNDS) {
    rounds += 1;
    update('fix', 'running', `Round ${rounds}: rewriting the files the compiler rejects…`);
    const repaired = await apis.repair(job.id, signal, (j) => update('fix', 'running', `Round ${rounds}: ${j.phase ?? j.status}`));
    if (repaired.status !== 'succeeded') break;
    job = repaired;
  }
  if (rounds === 0) update('fix', builds(job) ? 'skipped' : 'failed', builds(job) ? 'it built first time' : 'dependencies failed to install');
  else update('fix', builds(job) ? 'done' : 'failed', builds(job) ? `builds after ${rounds} round(s)` : `still failing after ${rounds} round(s) - open it to fix by hand`);

  update('pages', 'running', 'Listing pages…');
  const pages = await apis.pages(job.id).catch(() => [] as readonly RunPage[]);
  update('pages', 'done', pages.length === 0 ? 'no frontend pages' : `${pages.length} page(s): ${pages.map((p) => p.pageName).join(', ')}`);
  return { schema, job, pages, sessionCreatedAt: planned.createdAt, workflowJob: planned };
}
