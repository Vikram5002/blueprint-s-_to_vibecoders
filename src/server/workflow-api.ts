/**
 * HTTP surface for Layer 2: prompt -> ProjectSchema -> compiled constraints.
 *
 * The first production call site for both `createProjectSchemaGenerator()`
 * (`../workflow/generate-project-schema.js`) and `compileDomainConstraints()`
 * (`../workflow/compile-constraints.js`) — until now, only their own test
 * files and a throwaway diagnostic script called either. See
 * `docs/ADR-002-generation-api-request-model.md` for why this is
 * submit-and-poll rather than a single blocking request (the local model's
 * measured 10.7-27s with zero concurrency handling, not Gemini's faster
 * case, is what decided it), and `docs/ADR-001-*.md` for why the response
 * keeps `prohibitions` and `permissions` as two separate fields rather than
 * one flattened list — they are structurally different claims.
 *
 * Deliberately outside `AnalysisContext`: this doesn't analyse a repository
 * at all, it turns a prompt into a schema, so it needs an LLM provider and a
 * cache, not a walked/parsed/clustered repo. Kept as its own Hono sub-app
 * (`createWorkflowRoutes`) so it can be constructed and tested with only
 * those two things, then mounted into the main app with `.route()` — see
 * `server.ts`.
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { compileDomainConstraints, type WorkflowPermission } from '../workflow/compile-constraints.js';
import type { GenerateFailure, ProjectSchemaGenerator } from '../workflow/generate-project-schema.js';
import type { LabelCache } from '../llm/cache.js';
import type { Constraint } from '../types/constraints.js';
import type { ValidatedProjectSchema } from '../types/project-schema.js';

/**
 * Hard cap on jobs counted as `pending` or `running` together.
 *
 * ADR-002's addition to the submit-and-poll decision, made deliberately and
 * not deferred alongside the scaffold's other accepted gaps (no
 * persistence, no auth): an unbounded in-memory queue interacts directly
 * with the local model's measured behaviour — 10.7-27s per request with no
 * concurrency handling — so a burst of requests could otherwise degrade the
 * service in exactly the way submit-and-poll is designed to prevent. A
 * request that would exceed this is rejected immediately (503), never
 * silently queued past it. Named and exported so it is easy to tune later
 * without hunting for a magic number.
 */
export const MAX_CONCURRENT_JOBS = 8;

/** Sent as `Retry-After` on a capacity rejection — a hint, not a promise, sized around one local-model request's worst-case latency. */
const RETRY_AFTER_SECONDS = 30;

export type WorkflowJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface WorkflowJobResult {
  readonly schema: ValidatedProjectSchema;
  readonly prohibitions: readonly Constraint[];
  readonly permissions: readonly WorkflowPermission[];
}

export type WorkflowJobError =
  | ({ readonly phase: 'generate' } & GenerateFailure)
  | { readonly phase: 'compile'; readonly message: string };

export interface WorkflowJob {
  readonly id: string;
  readonly prompt: string;
  readonly createdAt: string;
  readonly status: WorkflowJobStatus;
  readonly result?: WorkflowJobResult;
  readonly error?: WorkflowJobError;
}

/**
 * In-memory only — a generation job is ephemeral, single-process state.
 * Named as an accepted scaffold gap in ADR-002's Consequences, not solved
 * here: a server restart loses every in-flight or completed job.
 *
 * Records are replaced wholesale on every transition (`set`), never
 * mutated in place — the same immutable-record discipline the rest of this
 * codebase uses for pipeline data, applied here to job state instead.
 */
export interface WorkflowJobStore {
  create(prompt: string): WorkflowJob;
  get(id: string): WorkflowJob | undefined;
  set(job: WorkflowJob): void;
  /** Jobs currently counted against MAX_CONCURRENT_JOBS: pending + running. */
  activeCount(): number;
}

export function createWorkflowJobStore(): WorkflowJobStore {
  const jobs = new Map<string, WorkflowJob>();
  return {
    create(prompt) {
      const job: WorkflowJob = { id: randomUUID(), prompt, createdAt: new Date().toISOString(), status: 'pending' };
      jobs.set(job.id, job);
      return job;
    },
    get(id) {
      return jobs.get(id);
    },
    set(job) {
      jobs.set(job.id, job);
    },
    activeCount() {
      let count = 0;
      for (const job of jobs.values()) {
        if (job.status === 'pending' || job.status === 'running') count += 1;
      }
      return count;
    },
  };
}

/** Bundled together because a cache is only worth flushing when there is a generator using it. */
export interface WorkflowLlmDeps {
  readonly generator: ProjectSchemaGenerator;
  readonly cache: LabelCache;
}

export interface WorkflowRouteDeps {
  /** Null when no provider is configured — `createProvider`'s own "no key" signal, propagated up rather than crashing. */
  readonly llm: WorkflowLlmDeps | null;
  /** Defaults to a fresh in-memory store; overridable so tests can inspect or pre-seed job state. */
  readonly jobs?: WorkflowJobStore;
}

/**
 * A standalone Hono sub-app, mounted at `/api/workflow` by `server.ts` via
 * `.route()`. Kept separate from `createApp`'s `AnalysisContext`-bound
 * routes so it can be constructed and tested with only an LLM dependency
 * and a job store — no repository walk required.
 */
export function createWorkflowRoutes(deps: WorkflowRouteDeps): Hono {
  const jobs = deps.jobs ?? createWorkflowJobStore();
  const app = new Hono();

  app.post('/jobs', async (c) => {
    if (deps.llm === null) {
      return c.json({ error: 'no LLM provider configured (missing API key)' }, 503);
    }
    const llm = deps.llm;

    const body: unknown = await c.req.json().catch(() => null);
    const prompt =
      typeof body === 'object' && body !== null ? (body as { prompt?: unknown }).prompt : undefined;
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return c.json({ error: 'expected { prompt: string }' }, 400);
    }

    if (jobs.activeCount() >= MAX_CONCURRENT_JOBS) {
      c.header('Retry-After', String(RETRY_AFTER_SECONDS));
      return c.json(
        {
          error: `at capacity: ${MAX_CONCURRENT_JOBS} job(s) already pending or running`,
          retryAfterSeconds: RETRY_AFTER_SECONDS,
        },
        503,
      );
    }

    const job = jobs.create(prompt);
    // Fire-and-forget: the whole point of submit-and-poll (ADR-002) is that
    // this handler returns before generation finishes. runJob's own
    // try/catch is what keeps every expected failure out of an unhandled
    // rejection; this .catch() is a defensive backstop for anything that
    // still escapes it, not the primary error path.
    runJob(jobs, job.id, prompt, llm).catch((cause) => {
      jobs.set({
        ...job,
        status: 'failed',
        error: { phase: 'compile', message: `unexpected: ${String(cause)}` },
      });
    });

    return c.json({ id: job.id, status: job.status }, 202);
  });

  app.get('/jobs/:id', (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    return job === undefined ? c.json({ error: `unknown job: ${id}` }, 404) : c.json(job);
  });

  return app;
}

/**
 * The real generate-then-compile work, run after the `POST` has already
 * responded (see the fire-and-forget call site above). Two real phases
 * live here, but compile is measured in microseconds — `compile-constraints.ts`'s
 * own docstring records ~8.46us for the compiler and ~1.89us for its
 * revalidation, against generate's multi-second latency — so there is no
 * meaningful intermediate status worth exposing between them, per ADR-002.
 */
async function runJob(store: WorkflowJobStore, jobId: string, prompt: string, llm: WorkflowLlmDeps): Promise<void> {
  const initial = store.get(jobId);
  if (initial === undefined) return; // defensive: the caller always creates the job first

  store.set({ ...initial, status: 'running' });

  const generated = await llm.generator.generate(prompt);
  // Flushed once per job regardless of outcome, same "flush after the
  // batch of work this call did" convention `pipeline/intent.ts` and
  // `pipeline/label-repository.ts` already use — a no-op if generate()
  // didn't add a new cache entry (a cache hit, or a rejected answer that
  // was never cached in the first place).
  await llm.cache.flush();

  if (!generated.ok) {
    store.set({ ...initial, status: 'failed', error: { phase: 'generate', ...generated.error } });
    return;
  }

  try {
    // generated.value is ValidatedProjectSchema by construction —
    // generate() returns Result<ValidatedProjectSchema, GenerateFailure> —
    // so this is the branded type flowing in unmodified, never cast past it.
    const compiled = compileDomainConstraints(generated.value);
    store.set({
      ...initial,
      status: 'succeeded',
      result: { schema: generated.value, prohibitions: compiled.prohibitions, permissions: compiled.permissions },
    });
  } catch (cause) {
    // compileDomainConstraints only throws on the "should never happen"
    // branded-bypass case its own docstring describes — real here only if
    // that invariant is ever actually violated, not a path this scaffold
    // expects to exercise.
    store.set({
      ...initial,
      status: 'failed',
      error: { phase: 'compile', message: cause instanceof Error ? cause.message : String(cause) },
    });
  }
}
