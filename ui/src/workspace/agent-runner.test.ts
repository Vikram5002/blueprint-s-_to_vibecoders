import { describe, expect, it } from 'vitest';
import { runAgent, stepsFor, type AgentApis, type StepId, type StepStatus } from './agent-runner';
import type { ApplicationJob } from './application-job-types';
import type { WorkflowJob } from './workflow-job-types';
import type { ProjectSchema } from './project-schema-types';

const schema = {
  sessionId: 's',
  title: 'Shop',
  originalPrompt: 'a shop',
  domains: {
    frontend: { components: [{ id: 'f', name: 'Home', purpose: 'p' }], dependsOn: ['backend'] },
    backend: { components: [{ id: 'b', name: 'Api', purpose: 'p' }], dependsOn: [] },
    database: { components: [], dependsOn: [] },
    security: { components: [], dependsOn: [] },
  },
  constraints: [],
  provenance: 'STATED',
} as unknown as ProjectSchema;

const planned = {
  id: 'w',
  prompt: 'a shop',
  createdAt: 't',
  status: 'succeeded',
  result: { schema, prohibitions: [], permissions: [] },
} as unknown as WorkflowJob;

function job(overrides: Partial<ApplicationJob>): ApplicationJob {
  return {
    id: 'j',
    createdAt: 't',
    sessionId: 's',
    kind: 'generate',
    status: 'succeeded',
    ...overrides,
  } as ApplicationJob;
}
const built = (buildOk: boolean, id = 'j'): ApplicationJob =>
  job({
    id,
    result: {
      files: [],
      regenerationLog: [],
      unresolvedViolations: [],
      unresolvedServiceLocatorFindings: [],
      build: { installOk: true, buildOk },
    },
  } as unknown as Partial<ApplicationJob>);

function apis(overrides: Partial<AgentApis>): { apis: AgentApis; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    apis: {
      plan: async () => (calls.push('plan'), planned),
      generate: async () => (calls.push('generate'), built(true)),
      continueRun: async () => (calls.push('continue'), built(true, 'c')),
      repair: async () => (calls.push('repair'), built(true, 'r')),
      pages: async () => (
        calls.push('pages'),
        [
          {
            path: 'frontend/src/pages/home.tsx',
            pageName: 'Home',
            layout: { id: 'x', pageName: 'Home', elements: [] },
            edited: false,
          },
        ]
      ),
      ...overrides,
    },
  };
}

async function run(
  a: AgentApis,
): Promise<{ outcome: Awaited<ReturnType<typeof runAgent>>; last: Map<StepId, StepStatus> }> {
  const last = new Map<StepId, StepStatus>();
  const outcome = await runAgent(
    'a shop',
    a,
    (id, status) => last.set(id, status),
    new AbortController().signal,
  );
  return { outcome, last };
}

describe('agent mode', () => {
  it('goes straight through when everything builds first time', async () => {
    const { apis: a, calls } = apis({});
    const { outcome, last } = await run(a);
    expect(calls).toEqual(['plan', 'generate', 'pages']);
    expect(last.get('continue')).toBe('skipped');
    expect(last.get('fix')).toBe('skipped');
    expect(outcome.pages).toHaveLength(1);
  });

  it('fixes a failing build, up to two rounds', async () => {
    let repairs = 0;
    const { apis: a } = apis({
      generate: async () => built(false),
      repair: async () => ((repairs += 1), built(repairs >= 2, `r${repairs}`)),
    });
    const { outcome, last } = await run(a);
    expect(repairs).toBe(2);
    expect(last.get('fix')).toBe('done');
    expect(outcome.job?.id).toBe('r2');
  });

  it('stops fixing after two rounds and says so', async () => {
    const { apis: a } = apis({
      generate: async () => built(false),
      repair: async () => built(false, 'r'),
    });
    const { last } = await run(a);
    expect(last.get('fix')).toBe('failed');
  });

  it('continues a run that stopped halfway, reusing its saved components', async () => {
    const stopped = job({
      status: 'failed',
      partialFiles: [{ path: 'a.ts', bytes: 1 }],
      error: { phase: 'unexpected', message: 'quota' },
    } as Partial<ApplicationJob>);
    const { apis: a, calls } = apis({ generate: async () => stopped });
    const { last } = await run(a);
    expect(calls).toEqual(['plan', 'continue', 'pages']);
    expect(last.get('continue')).toBe('done');
  });

  it('stops early, clearly, when planning fails', async () => {
    const { apis: a, calls } = apis({
      plan: async () =>
        ({ id: 'w', prompt: 'a shop', createdAt: 't', status: 'failed' }) as unknown as WorkflowJob,
    });
    const { last } = await run(a);
    expect(calls).toEqual([]);
    expect(last.get('plan')).toBe('failed');
  });
});

describe('agent mode with a plan review', () => {
  const revised = { ...schema, title: 'Shop with admin' } as ProjectSchema;
  const revisedJob = {
    ...planned,
    prompt: 'a shop\n\nChanges to the plan:\n- add admin',
  } as WorkflowJob;

  it('asks before generating, then builds the plan the person approved', async () => {
    const { apis: a, calls } = apis({
      generate: async (s) => (calls.push(`generate:${s.title}`), built(true)),
    });
    const last = new Map<StepId, StepStatus>();
    const outcome = await runAgent(
      'a shop',
      a,
      (id, status) => last.set(id, status),
      new AbortController().signal,
      {
        review: async (proposed) => {
          calls.push(`review:${proposed.title}`);
          return { kind: 'approve', schema: revised, workflowJob: revisedJob };
        },
      },
    );
    expect(calls).toEqual(['plan', 'review:Shop', 'generate:Shop with admin', 'pages']);
    expect(last.get('review')).toBe('done');
    expect(outcome.schema?.title).toBe('Shop with admin');
    expect(outcome.workflowJob?.prompt).toContain('add admin');
  });

  it('generates nothing when the person cancels at the review', async () => {
    const { apis: a, calls } = apis({});
    const last = new Map<StepId, StepStatus>();
    const outcome = await runAgent(
      'a shop',
      a,
      (id, status) => last.set(id, status),
      new AbortController().signal,
      {
        review: async () => ({ kind: 'cancel' }),
      },
    );
    expect(calls).toEqual(['plan']);
    expect(last.get('review')).toBe('failed');
    expect(last.get('generate')).toBe('skipped');
    expect(outcome.job).toBeNull();
  });

  it('shows the review step only when one was asked for', () => {
    expect(stepsFor(false).map((step) => step.id)).toEqual([
      'plan',
      'generate',
      'continue',
      'fix',
      'pages',
    ]);
    expect(stepsFor(true).map((step) => step.id)).toEqual([
      'plan',
      'review',
      'generate',
      'continue',
      'fix',
      'pages',
    ]);
  });
});
