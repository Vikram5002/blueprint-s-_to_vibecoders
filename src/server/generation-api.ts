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
 *
 * ## Saved runs
 *
 * A finished job is persisted (`runs`, src/store/application-runs-store.ts)
 * against the session its schema came from, so reopening that session
 * shows the last run instead of a blank panel, and its files on disk stay
 * reachable after a restart. Three follow-up actions work on a saved run:
 *
 * - `POST /application-jobs/:id/repair` - a NEW job that starts from the
 *   saved run's files (copied, never edited in place), rebuilds, and
 *   regenerates only the files `tsc` still names. Costs a fraction of a
 *   full "Generate Application", which is why it exists.
 * - `GET/PUT /application-jobs/:id/pages` - each generated frontend page
 *   as a Page Builder layout (extracted from the model's file, or the last
 *   saved edit), and saving an edited layout back as the page's real file.
 * - `POST /application-jobs/:id/pages/restore` - puts the model's original
 *   file back.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  generateAndVerifyProject,
  verifyGeneratedProject,
  writeProjectFiles,
  type GenerateAndVerifyFailure,
  type GenerationPhase,
  type RegenerationAttempt,
} from '../generate/verify-and-regenerate.js';
import { installBuildAndRepair, summarise, type BuildOutcome, type BuildPhase, type FileSummary } from '../generate/build-and-repair.js';
import { detectServiceLocatorEvasion } from '../generate/detect-service-locator-evasion.js';
import { findComponentByTargetPath } from '../generate/generate-project.js';
import { extractLayoutFromComponent } from '../generate/extract-layout.js';
import { layoutToComponentFile, pageLayoutTargetPath, validatePageLayout, type PageLayout } from '../generate/canvas-layout.js';
import { parsePageLayout } from './page-builder-api.js';
import { buildZipArchive } from '../export/zip.js';
import { validateProjectSchema } from '../workflow/validate-project-schema.js';
import type { ApplicationRunsStore, ApplicationRunKind } from '../store/application-runs-store.js';
import type { CompletionProvider } from '../llm/provider.js';
import type { LabelCache } from '../llm/cache.js';
import type { ValidatedProjectSchema } from '../types/project-schema.js';
import type { Violation } from '../types/violations.js';
import type { SuspectedServiceLocatorEvasion } from '../generate/detect-service-locator-evasion.js';

export type ApplicationJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/** Defined next to the code that produces them (src/generate/build-and-repair.ts); re-exported so this module's API surface is unchanged. */
export type { BuildOutcome, FileSummary };

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
  /** The workflow session (schema.sessionId) this job generates for - what a saved run is filed under. */
  readonly sessionId: string;
  readonly kind: ApplicationRunKind;
  /** For a repair: the job whose files it started from. */
  readonly parentId?: string;
  readonly status: ApplicationJobStatus;
  readonly phase?: GenerationPhase | BuildPhase;
  readonly result?: ApplicationJobResult;
  readonly error?: ApplicationJobError;
}

export interface ApplicationJobStore {
  create(init?: { readonly sessionId?: string; readonly kind?: ApplicationRunKind; readonly parentId?: string }): ApplicationJob;
  get(id: string): ApplicationJob | undefined;
  set(job: ApplicationJob): void;
  activeCount(): number;
}

/** What a saved run holds: the finished job plus the schema it was generated from, so a repair needs nothing else. */
export interface ApplicationRunPayload {
  readonly job: ApplicationJob;
  readonly schema: ValidatedProjectSchema;
}

export type GenerationRunsStore = ApplicationRunsStore<ApplicationRunPayload, PageLayout>;

/** Same cap posture as workflow-api.ts's MAX_CONCURRENT_JOBS, sized down: this job does real npm install/build subprocess work per slot, not just one LLM call. */
export const MAX_CONCURRENT_APPLICATION_JOBS = 4;

const RETRY_AFTER_SECONDS = 60;

export function createApplicationJobStore(): ApplicationJobStore {
  const jobs = new Map<string, ApplicationJob>();
  return {
    create(init = {}) {
      const job: ApplicationJob = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        sessionId: init.sessionId ?? '',
        kind: init.kind ?? 'generate',
        ...(init.parentId === undefined ? {} : { parentId: init.parentId }),
        status: 'pending',
      };
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
  /** Where finished jobs are saved. Optional so the routes work (without memory) in tests and without a database. */
  readonly runs?: GenerationRunsStore;
}

type Llm = { readonly provider: CompletionProvider; readonly cache: LabelCache };

const FRONTEND_PAGE_PREFIX = 'frontend/src/pages/';

export function createGenerationRoutes(deps: ApplicationRouteDeps): Hono {
  const jobs = deps.jobs ?? createApplicationJobStore();
  const runs = deps.runs;
  const app = new Hono();

  /** A live job, or a saved one - the same shape either way, so every read route works after a restart. */
  function findJob(id: string): ApplicationJob | undefined {
    return jobs.get(id) ?? runs?.get(id)?.job.job;
  }

  function persist(job: ApplicationJob, schema: ValidatedProjectSchema): void {
    if (runs === undefined || (job.status !== 'succeeded' && job.status !== 'failed')) return;
    try {
      runs.save({
        id: job.id,
        sessionId: job.sessionId,
        kind: job.kind,
        parentId: job.parentId ?? null,
        status: job.status,
        createdAt: job.createdAt,
        job: { job, schema },
      });
    } catch {
      // Best effort, like workflow-api.ts's session save: a persistence
      // failure never turns a finished job into a failed one.
    }
  }

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

    const capacity = atCapacity(jobs, c);
    if (capacity !== null) return capacity;

    const job = jobs.create({ sessionId: validated.value.sessionId, kind: 'generate' });
    const root = join(deps.generationRoot, job.id);
    runApplicationJob(jobs, job.id, validated.value, llm, root)
      .then(() => {
        const finished = jobs.get(job.id);
        if (finished !== undefined) persist(finished, validated.value);
      })
      .catch((cause) => {
        const failed: ApplicationJob = { ...job, status: 'failed', error: { phase: 'unexpected', message: `unexpected: ${String(cause)}` } };
        jobs.set(failed);
        persist(failed, validated.value);
      });

    return c.json({ id: job.id, status: job.status }, 202);
  });

  app.post('/application-jobs/:id/repair', async (c) => {
    if (deps.llm === null) {
      return c.json({ error: 'no LLM provider configured (missing API key)' }, 503);
    }
    const llm = deps.llm;
    const id = c.req.param('id');
    const parent = findJob(id);
    const schema = runs?.get(id)?.job.schema;
    if (parent === undefined || parent.result === undefined) {
      return c.json({ error: `application job ${id} has no finished result to repair` }, 404);
    }
    if (schema === undefined) {
      return c.json({ error: `application job ${id} was not saved with its schema - only saved runs can be repaired` }, 409);
    }
    if (parent.result.build.installOk && parent.result.build.buildOk) {
      return c.json({ error: 'this run already builds cleanly - use Generate Application for a full regeneration' }, 409);
    }

    const body: unknown = await c.req.json().catch(() => null);
    const rawInstruction = typeof body === 'object' && body !== null ? (body as { instruction?: unknown }).instruction : undefined;
    const instruction = typeof rawInstruction === 'string' && rawInstruction.trim() !== '' ? rawInstruction.trim() : undefined;

    const capacity = atCapacity(jobs, c);
    if (capacity !== null) return capacity;

    const job = jobs.create({ sessionId: parent.sessionId, kind: 'repair', parentId: parent.id });
    const parentRoot = join(deps.generationRoot, parent.id);
    const root = join(deps.generationRoot, job.id);
    const parentFiles = parent.result.files;

    runRepairJob(jobs, job.id, schema, llm, { parentRoot, parentFiles, root, instruction })
      .then(() => {
        const finished = jobs.get(job.id);
        if (finished !== undefined) persist(finished, schema);
      })
      .catch((cause) => {
        const failed: ApplicationJob = { ...job, status: 'failed', error: { phase: 'unexpected', message: `unexpected: ${String(cause)}` } };
        jobs.set(failed);
        persist(failed, schema);
      });

    return c.json({ id: job.id, status: job.status }, 202);
  });

  app.get('/application-jobs/:id', (c) => {
    const id = c.req.param('id');
    const job = findJob(id);
    return job === undefined ? c.json({ error: `unknown application job: ${id}` }, 404) : c.json(job);
  });

  app.get('/application-jobs/:id/download', async (c) => {
    const id = c.req.param('id');
    const job = findJob(id);
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

  // ---- Saved runs per session -------------------------------------------

  app.get('/sessions/:id/application-runs', (c) => {
    const sessionId = c.req.param('id');
    const list = runs?.listForSession(sessionId) ?? [];
    const latest = runs?.latestForSession(sessionId)?.job.job;
    return c.json({ runs: list, latest: latest ?? null });
  });

  app.get('/application-runs/latest', (c) => {
    const latest = runs?.latestRuns() ?? [];
    return c.json({
      runs: latest.map((record) => ({
        sessionId: record.sessionId,
        runId: record.id,
        status: record.status,
        buildOk: record.job.job.result?.build.buildOk ?? false,
      })),
    });
  });

  // ---- Pages of a run, as Page Builder layouts ---------------------------

  app.get('/application-jobs/:id/pages', async (c) => {
    const id = c.req.param('id');
    const job = findJob(id);
    const schema = runs?.get(id)?.job.schema;
    if (job === undefined || job.result === undefined) {
      return c.json({ error: `application job ${id} has no generated files` }, 404);
    }
    const root = join(deps.generationRoot, id);
    const pages = await Promise.all(
      job.result.files
        .filter((file) => isFrontendPage(file.path))
        .map(async (file) => {
          const stored = runs?.getPageLayout(id, file.path);
          const pageName = pageNameFor(schema, file.path);
          if (stored !== undefined) {
            return { path: file.path, pageName, layout: stored.layout, edited: true };
          }
          const source = await readGeneratedFile(root, file.path);
          return { path: file.path, pageName, layout: extractLayoutFromComponent(source, pageName, `${id}:${file.path}`), edited: false };
        }),
    );
    return c.json({ pages });
  });

  app.put('/application-jobs/:id/pages', async (c) => {
    const id = c.req.param('id');
    const job = findJob(id);
    if (job === undefined || job.result === undefined) {
      return c.json({ error: `application job ${id} has no generated files` }, 404);
    }
    if (runs === undefined) {
      return c.json({ error: 'page edits need a database to be saved in' }, 503);
    }
    const body: unknown = await c.req.json().catch(() => null);
    const layout = parsePageLayout(body);
    if (layout === null) return c.json({ error: 'expected { layout: PageLayout }' }, 400);
    const errors = validatePageLayout(layout);
    if (errors.length > 0) return c.json({ error: 'layout failed validation', errors }, 400);

    const path = pageLayoutTargetPath(layout);
    if (!job.result.files.some((file) => file.path === path)) {
      return c.json({ error: `${path} is not a page of this run - the page name must stay the component's name` }, 400);
    }

    const root = join(deps.generationRoot, id);
    const existing = runs.getPageLayout(id, path);
    const originalSource = existing?.originalSource ?? (await readGeneratedFile(root, path));
    const file = layoutToComponentFile(layout);
    await writeProjectFiles(root, [file], false);
    runs.savePageLayout({ runId: id, path, layout, originalSource });
    return c.json({ file });
  });

  app.post('/application-jobs/:id/pages/restore', async (c) => {
    const id = c.req.param('id');
    const body: unknown = await c.req.json().catch(() => null);
    const path = typeof body === 'object' && body !== null ? (body as { path?: unknown }).path : undefined;
    if (typeof path !== 'string') return c.json({ error: 'expected { path: string }' }, 400);
    const stored = runs?.getPageLayout(id, path);
    if (runs === undefined || stored === undefined) {
      return c.json({ error: `${path} has no saved edit to restore` }, 404);
    }
    await writeProjectFiles(join(deps.generationRoot, id), [{ path, contents: stored.originalSource }], false);
    runs.deletePageLayout(id, path);
    return c.json({ restored: path });
  });

  return app;
}

function atCapacity(jobs: ApplicationJobStore, c: { header(name: string, value: string): void; json(body: unknown, status: 503): Response }): Response | null {
  if (jobs.activeCount() < MAX_CONCURRENT_APPLICATION_JOBS) return null;
  c.header('Retry-After', String(RETRY_AFTER_SECONDS));
  return c.json(
    {
      error: `at capacity: ${MAX_CONCURRENT_APPLICATION_JOBS} application job(s) already pending or running`,
      retryAfterSeconds: RETRY_AFTER_SECONDS,
    },
    503,
  );
}

function isFrontendPage(path: string): boolean {
  return path.startsWith(FRONTEND_PAGE_PREFIX) && path.endsWith('.tsx');
}

/** The component's own name when the schema is known (so a saved layout compiles back to the same file), else a readable name from the file's slug. */
function pageNameFor(schema: ValidatedProjectSchema | undefined, path: string): string {
  const owner = schema === undefined ? null : findComponentByTargetPath(schema, path);
  if (owner !== null) return owner.component.name;
  const slug = path.slice(FRONTEND_PAGE_PREFIX.length).replace(/\.tsx$/, '');
  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function readGeneratedFile(root: string, relativePath: string): Promise<string> {
  return readFile(join(root, ...relativePath.split('/')), 'utf8');
}

function setPhase(store: ApplicationJobStore, jobId: string, phase: NonNullable<ApplicationJob['phase']>): void {
  const latest = store.get(jobId);
  if (latest !== undefined) store.set({ ...latest, phase });
}

function finish(store: ApplicationJobStore, jobId: string, result: ApplicationJobResult): void {
  const current = store.get(jobId);
  if (current === undefined) return;
  const { phase: _finishedPhase, ...withoutPhase } = current;
  store.set({ ...withoutPhase, status: 'succeeded', result });
}

function fail(store: ApplicationJobStore, jobId: string, error: ApplicationJobError): void {
  const current = store.get(jobId);
  if (current === undefined) return;
  store.set({ ...current, status: 'failed', error });
}

async function runApplicationJob(
  store: ApplicationJobStore,
  jobId: string,
  schema: ValidatedProjectSchema,
  llm: Llm,
  root: string,
): Promise<void> {
  const current = store.get(jobId);
  if (current === undefined) return;
  store.set({ ...current, status: 'running' });

  const generated = await generateAndVerifyProject(schema, {
    provider: llm.provider,
    cache: llm.cache,
    // Generating a real application is a deliberate, user-triggered action,
    // not a repeated measurement of an unchanging repo (see skipCache's own
    // doc comment, component-codegen.ts) - every job asks the provider
    // fresh for every component, first attempt and retry alike.
    skipCache: true,
    root,
    onPhase: (phase: GenerationPhase) => setPhase(store, jobId, phase),
  });
  await llm.cache.flush();

  if (!generated.ok) {
    fail(store, jobId, { phase: 'generate-application', ...generated.error });
    return;
  }

  const built = await installBuildAndRepair({
    schema,
    llm,
    root,
    files: generated.value.files,
    onPhase: (phase) => setPhase(store, jobId, phase),
  });
  if (!built.ok) {
    fail(store, jobId, { phase: 'generate-application', ...built.error });
    return;
  }

  finish(store, jobId, {
    files: summarise(built.value.files),
    regenerationLog: [...generated.value.regenerationLog, ...built.value.regenerationLog],
    unresolvedViolations: generated.value.unresolvedViolations,
    unresolvedServiceLocatorFindings: generated.value.unresolvedServiceLocatorFindings,
    build: built.value.build,
  });
}

/**
 * Starts from a saved run's files instead of a fresh generation. Only the
 * files `tsc` names are ever regenerated, so a repair costs a handful of
 * provider calls rather than one per component. Blueprint verification is
 * re-run on the result, since a regenerated file can violate a constraint
 * the original did not.
 */
async function runRepairJob(
  store: ApplicationJobStore,
  jobId: string,
  schema: ValidatedProjectSchema,
  llm: Llm,
  source: {
    readonly parentRoot: string;
    readonly parentFiles: readonly FileSummary[];
    readonly root: string;
    readonly instruction: string | undefined;
  },
): Promise<void> {
  const current = store.get(jobId);
  if (current === undefined) return;
  store.set({ ...current, status: 'running', phase: 'generating' });

  const files = await Promise.all(
    source.parentFiles.map(async (file) => ({ path: file.path, contents: await readGeneratedFile(source.parentRoot, file.path) })),
  );
  await writeProjectFiles(source.root, files, true);

  const built = await installBuildAndRepair({
    schema,
    llm,
    root: source.root,
    files,
    ...(source.instruction === undefined ? {} : { instruction: source.instruction }),
    onPhase: (phase) => setPhase(store, jobId, phase),
  });
  await llm.cache.flush();
  if (!built.ok) {
    fail(store, jobId, { phase: 'generate-application', ...built.error });
    return;
  }

  setPhase(store, jobId, 'reverifying');
  const verified = await verifyGeneratedProject(source.root, schema);
  if (!verified.ok) {
    fail(store, jobId, { phase: 'generate-application', ...verified.error });
    return;
  }

  finish(store, jobId, {
    files: summarise(built.value.files),
    regenerationLog: built.value.regenerationLog,
    unresolvedViolations: verified.value,
    unresolvedServiceLocatorFindings: detectServiceLocatorEvasion(built.value.files, schema.constraints),
    build: built.value.build,
  });
}
