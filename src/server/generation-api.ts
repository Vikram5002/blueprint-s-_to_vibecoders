/**
 * HTTP surface for Layer 3: ProjectSchema -> real generated code -> real
 * assembled project -> verified, downloadable output.
 *
 * The final milestone's whole point: the generation pipeline proven by
 * Milestones 1-3 (src/generate/verify-and-regenerate.ts) has been reachable
 * only from a script's `import`, never from a real request a browser could
 * send. This mounts it the same way Layer 2 already is - submit-and-poll,
 * per docs/ADR-002-generation-api-request-model.md - because full
 * generation+install+build+verify is measured at ~100s for a 9-component
 * schema (Milestone 3's own scale test), far past anything a synchronous
 * request should ever attempt.
 *
 * Deliberately a separate Hono sub-app from workflow-api.ts, mounted
 * alongside it at `/api/workflow` by server.ts: that module's job is
 * prompt -> schema, needing only an LLM generator. This module's job is
 * schema -> real files on disk -> installed -> built -> verified, needing
 * an LLM provider for component generation AND a real filesystem location
 * to write to and run `npm` in. Sharing one job-shaped contract style
 * across both, not one combined app.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  generateAndVerifyProject,
  type GenerateAndVerifyFailure,
  type GenerationPhase,
  type RegenerationAttempt,
} from '../generate/verify-and-regenerate.js';
import { buildZipArchive } from '../export/zip.js';
import { validateProjectSchema } from '../workflow/validate-project-schema.js';
import type { CompletionProvider } from '../llm/provider.js';
import type { LabelCache } from '../llm/cache.js';
import type { GeneratedFile } from '../generate/assemble.js';
import type { Violation } from '../types/violations.js';
import type { SuspectedServiceLocatorEvasion } from '../generate/detect-service-locator-evasion.js';

export type ApplicationJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface FileSummary {
  readonly path: string;
  readonly bytes: number;
}

export interface BuildOutcome {
  readonly installOk: boolean;
  readonly buildOk: boolean;
  /** Last ~4000 chars of combined stdout+stderr for whichever step failed first. Never populated on a clean pass. */
  readonly failureOutput?: string;
}

export interface ApplicationJobResult {
  readonly files: readonly FileSummary[];
  readonly regenerationLog: readonly RegenerationAttempt[];
  /**
   * Real, unresolved Blueprint violations after every eligible retry ran -
   * never hidden or summarised away. A non-empty array here means the
   * generated project has at least one component that needs human review;
   * `status` still reports 'succeeded' for the job itself (generation and
   * verification both ran to completion), the UI's job is to show this
   * list honestly, not to fold it into a pass/fail boolean.
   */
  readonly unresolvedViolations: readonly Violation[];
  /**
   * Item 3: real, unresolved suspected auth-bypass-style findings - see
   * `GenerateAndVerifyResult`'s field of the same name in
   * verify-and-regenerate.ts for why this is never merged into
   * `unresolvedViolations`.
   */
  readonly unresolvedServiceLocatorFindings: readonly SuspectedServiceLocatorEvasion[];
  readonly build: BuildOutcome;
}

export type ApplicationJobError =
  | ({ readonly phase: 'generate-application' } & GenerateAndVerifyFailure)
  | { readonly phase: 'unexpected'; readonly message: string };

export interface ApplicationJob {
  readonly id: string;
  readonly createdAt: string;
  readonly status: ApplicationJobStatus;
  readonly phase?: GenerationPhase | 'installing' | 'building';
  readonly result?: ApplicationJobResult;
  readonly error?: ApplicationJobError;
}

export interface ApplicationJobStore {
  create(): ApplicationJob;
  get(id: string): ApplicationJob | undefined;
  set(job: ApplicationJob): void;
  activeCount(): number;
}

/** Same cap posture as workflow-api.ts's MAX_CONCURRENT_JOBS, sized down: this job does real npm install/build subprocess work per slot, not just one LLM call. */
export const MAX_CONCURRENT_APPLICATION_JOBS = 4;

const RETRY_AFTER_SECONDS = 60;

export function createApplicationJobStore(): ApplicationJobStore {
  const jobs = new Map<string, ApplicationJob>();
  return {
    create() {
      const job: ApplicationJob = { id: randomUUID(), createdAt: new Date().toISOString(), status: 'pending' };
      jobs.set(job.id, job);
      return job;
    },
    get: (id) => jobs.get(id),
    set: (job) => jobs.set(job.id, job),
    activeCount() {
      let count = 0;
      for (const job of jobs.values()) {
        if (job.status === 'pending' || job.status === 'running') count += 1;
      }
      return count;
    },
  };
}

export interface ApplicationRouteDeps {
  readonly llm: { readonly provider: CompletionProvider; readonly cache: LabelCache } | null;
  /** Directory each job writes its generated project under, one subfolder per job id - see resolveGenerationRoot in server.ts. */
  readonly generationRoot: string;
  readonly jobs?: ApplicationJobStore;
}

export function createGenerationRoutes(deps: ApplicationRouteDeps): Hono {
  const jobs = deps.jobs ?? createApplicationJobStore();
  const app = new Hono();

  app.post('/application-jobs', async (c) => {
    if (deps.llm === null) {
      return c.json({ error: 'no LLM provider configured (missing API key)' }, 503);
    }
    const llm = deps.llm;

    const body: unknown = await c.req.json().catch(() => null);
    const candidateSchema = typeof body === 'object' && body !== null ? (body as { schema?: unknown }).schema : undefined;
    if (candidateSchema === undefined) {
      return c.json({ error: 'expected { schema: ProjectSchema }' }, 400);
    }
    const validated = validateProjectSchema(candidateSchema);
    if (!validated.ok) {
      return c.json({ error: 'schema failed validation', rejections: validated.error }, 400);
    }

    if (jobs.activeCount() >= MAX_CONCURRENT_APPLICATION_JOBS) {
      c.header('Retry-After', String(RETRY_AFTER_SECONDS));
      return c.json(
        {
          error: `at capacity: ${MAX_CONCURRENT_APPLICATION_JOBS} application job(s) already pending or running`,
          retryAfterSeconds: RETRY_AFTER_SECONDS,
        },
        503,
      );
    }

    const job = jobs.create();
    const root = join(deps.generationRoot, job.id);
    runApplicationJob(jobs, job.id, validated.value, llm, root).catch((cause) => {
      jobs.set({
        ...job,
        status: 'failed',
        error: { phase: 'unexpected', message: `unexpected: ${String(cause)}` },
      });
    });

    return c.json({ id: job.id, status: job.status }, 202);
  });

  app.get('/application-jobs/:id', (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    return job === undefined ? c.json({ error: `unknown application job: ${id}` }, 404) : c.json(job);
  });

  app.get('/application-jobs/:id/download', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === undefined) {
      return c.json({ error: `unknown application job: ${id}` }, 404);
    }
    if (job.result === undefined) {
      return c.json({ error: `application job ${id} has no generated files yet (status: ${job.status})` }, 409);
    }

    const root = join(deps.generationRoot, id);
    const entries = await Promise.all(
      job.result.files.map(async (file) => ({
        path: file.path,
        contents: await readGeneratedFile(root, file.path),
      })),
    );
    const zip = buildZipArchive(entries);

    c.header('content-type', 'application/zip');
    c.header('content-disposition', `attachment; filename="generated-${id}.zip"`);
    return c.body(new Uint8Array(zip).buffer as ArrayBuffer);
  });

  return app;
}

async function readGeneratedFile(root: string, relativePath: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(join(root, ...relativePath.split('/')), 'utf8');
}

/** Trimmed to keep a failed job's payload bounded - a full npm log can run to tens of KB, and only the tail is ever the actionable part. */
const MAX_FAILURE_OUTPUT_CHARS = 4_000;

function runCommand(command: string, args: readonly string[], cwd: string): Promise<{ readonly ok: boolean; readonly output: string }> {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, { cwd, shell: true });
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (code) => resolve({ ok: code === 0, output: output.slice(-MAX_FAILURE_OUTPUT_CHARS) }));
    child.on('error', (cause) => resolve({ ok: false, output: String(cause) }));
  });
}

async function runApplicationJob(
  store: ApplicationJobStore,
  jobId: string,
  schema: Parameters<typeof generateAndVerifyProject>[0],
  llm: { readonly provider: CompletionProvider; readonly cache: LabelCache },
  root: string,
): Promise<void> {
  let current = store.get(jobId);
  if (current === undefined) return;

  current = { ...current, status: 'running' };
  store.set(current);

  const generated = await generateAndVerifyProject(schema, {
    provider: llm.provider,
    cache: llm.cache,
    root,
    onPhase: (phase: GenerationPhase) => {
      const latest = store.get(jobId);
      if (latest !== undefined) store.set({ ...latest, phase });
    },
  });
  await llm.cache.flush();

  // Re-read after generateAndVerifyProject: onPhase has been updating the
  // stored record throughout, so the local `current` variable is stale by
  // now - the store, not this variable, is the source of truth for what
  // happened while generation ran.
  current = store.get(jobId);
  if (current === undefined) return;

  if (!generated.ok) {
    store.set({ ...current, status: 'failed', error: { phase: 'generate-application', ...generated.error } });
    return;
  }

  current = { ...current, phase: 'installing' };
  store.set(current);
  const install = await runCommand('npm', ['install', '--no-audit', '--no-fund'], root);

  let build = { ok: false, output: '' };
  if (install.ok) {
    current = { ...current, phase: 'building' };
    store.set(current);
    build = await runCommand('npm', ['run', 'build'], root);
  }

  const files: FileSummary[] = generated.value.files.map((file: GeneratedFile) => ({
    path: file.path,
    bytes: Buffer.byteLength(file.contents, 'utf8'),
  }));

  const buildOutcome: BuildOutcome = {
    installOk: install.ok,
    buildOk: install.ok && build.ok,
    ...(install.ok && build.ok ? {} : { failureOutput: install.ok ? build.output : install.output }),
  };

  const { phase: _finishedPhase, ...withoutPhase } = current;
  store.set({
    ...withoutPhase,
    status: 'succeeded',
    result: {
      files,
      regenerationLog: generated.value.regenerationLog,
      unresolvedViolations: generated.value.unresolvedViolations,
      unresolvedServiceLocatorFindings: generated.value.unresolvedServiceLocatorFindings,
      build: buildOutcome,
    },
  });
}
