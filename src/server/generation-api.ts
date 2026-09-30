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
import { planConstraints } from '../generate/plan-rules.js';
import { findComponentByTargetPath } from '../generate/generate-project.js';
import { extractLayoutFromComponent } from '../generate/extract-layout.js';
import { layoutToComponentFile, pageLayoutTargetPath, validatePageLayout, type PageLayout } from '../generate/canvas-layout.js';
import { parsePageLayout } from './page-builder-api.js';
import { buildZipArchive } from '../export/zip.js';
import { withRunScaffold } from '../export/runnable-project.js';
import { withProjectPack, type PackVerification } from '../export/project-pack.js';
import { componentTargetPath, type GeneratedFile } from '../generate/assemble.js';
import { readProjectFiles, schemaFromProjectFiles } from '../generate/import-project.js';
import { cloneDirectoryFor, cloneRepository, parseGitUrl, validateBranch } from '../ingest/git-source.js';
import { compileDomainConstraints } from '../workflow/compile-constraints.js';
import type { WorkflowSessionsStore } from '../store/workflow-sessions-store.js';
import { componentId, DOMAIN_NAMES, type DomainName } from '../types/project-schema.js';
import { runCommand } from '../generate/build-and-repair.js';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { generatePageSyncFiles, planPageSync, type PageSyncPlan } from '../generate/page-sync.js';
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
  /**
   * Component files written so far, updated as each one lands. A run that
   * fails mid-generation keeps them on disk, and "Continue generation"
   * reuses them instead of starting over.
   */
  readonly partialFiles?: readonly FileSummary[];
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
  /** Workflow sessions, so an imported project gets a session of its own. Import is unavailable without it. */
  readonly sessions?: WorkflowSessionsStore;
  /** Where an imported Git repository is cloned (inside this tool's .vibe folder). */
  readonly cloneRoot?: string;
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
        // From the job's latest state, not its starting one: that keeps the
        // partialFiles a crash would otherwise throw away.
        const failed: ApplicationJob = { ...(jobs.get(job.id) ?? job), status: 'failed', error: { phase: 'unexpected', message: `unexpected: ${String(cause)}` } };
        jobs.set(failed);
        persist(failed, validated.value);
      });

    return c.json({ id: job.id, status: job.status }, 202);
  });

  // Import a project a person has been building (a local folder or a Git
  // repository in this tool's layout) as a session with a run of its own - no
  // model call: its plan is read from its folders, then it is installed,
  // built and checked, so every edit afterwards starts from the truth.
  app.post('/import', async (c) => {
    if (runs === undefined || deps.sessions === undefined) return c.json({ error: 'import needs the local database' }, 503);
    const body: unknown = await c.req.json().catch(() => null);
    const source = parseImportSource(body);
    if (typeof source === 'string') return c.json({ error: source }, 400);
    if (source.kind === 'local') {
      const info = await stat(source.path).catch(() => null);
      if (info === null || !info.isDirectory()) return c.json({ error: `not a folder: ${source.path}` }, 400);
    }
    if (source.kind === 'git' && deps.cloneRoot === undefined) return c.json({ error: 'git import is not configured' }, 503);

    const capacity = atCapacity(jobs, c);
    if (capacity !== null) return capacity;
    const sessionId = randomUUID();
    const job = jobs.create({ sessionId, kind: 'import' });
    const root = join(deps.generationRoot, job.id);
    const sessions = deps.sessions;
    // A failed import has no plan, and runs are only ever listed under a
    // session, so it is recorded under a session of its own with an empty
    // plan - otherwise the failure would be gone after a restart.
    const recordFailure = (failed: ApplicationJob): void => {
      // The session exists when the import got as far as reading the files.
      const schema = sessions.get(sessionId)?.schema ?? failedImportSchema(sessionId, source);
      if (schema === null) return;
      if (sessions.get(sessionId) === undefined) saveSessionSchema(sessions, schema, schema.originalPrompt);
      persist(failed, schema);
    };
    runImportJob(jobs, job.id, source, { sessionId, root, cloneRoot: deps.cloneRoot ?? '', sessions })
      .then((schema) => {
        const finished = jobs.get(job.id);
        if (finished === undefined) return;
        if (schema !== null) persist(finished, schema);
        else if (finished.status === 'failed') recordFailure(finished);
      })
      .catch((cause) => {
        const failed: ApplicationJob = { ...(jobs.get(job.id) ?? job), status: 'failed', error: { phase: 'unexpected', message: `unexpected: ${String(cause)}` } };
        jobs.set(failed);
        recordFailure(failed);
      });
    return c.json({ id: job.id, status: job.status, sessionId }, 202);
  });

  // Add or remove components on a run: removed components' files go, new
  // ones are generated with the existing files as context, and every other
  // file - generated or hand-written - is kept as it is.
  app.post('/application-jobs/:id/components', async (c) => {
    if (deps.llm === null) return c.json({ error: 'no LLM provider configured (missing API key)' }, 503);
    const llm = deps.llm;
    const id = c.req.param('id');
    const parent = findJob(id);
    const schema = runs?.get(id)?.job.schema;
    if (parent?.result === undefined || schema === undefined) return c.json({ error: `application job ${id} is not a saved, finished run` }, 404);
    const edit = parseComponentEdit(await c.req.json().catch(() => null));
    if (typeof edit === 'string') return c.json({ error: edit }, 400);
    const edited = editSchemaComponents(schema, edit);
    if (typeof edited === 'string') return c.json({ error: edited }, 400);

    const capacity = atCapacity(jobs, c);
    if (capacity !== null) return capacity;
    const parentRoot = join(deps.generationRoot, parent.id);
    const all = await Promise.all(parent.result.files.map(async (file) => ({ path: file.path, contents: await readGeneratedFile(parentRoot, file.path) })));
    const gone = removedPaths(schema, edit);
    const kept = all.filter((file) => !gone.has(file.path));
    const componentPaths = new Set(DOMAIN_NAMES.flatMap((domain) => edited.domains[domain].components.map((component) => componentTargetPath(domain, component))));
    const existing = kept.filter((file) => componentPaths.has(file.path));
    const carried = kept.filter((file) => !componentPaths.has(file.path));

    const job = jobs.create({ sessionId: parent.sessionId, kind: 'edit', parentId: parent.id });
    const root = join(deps.generationRoot, job.id);
    for (const page of runs?.listPageLayouts(id) ?? []) if (componentPaths.has(page.path)) runs?.savePageLayout({ ...page, runId: job.id });
    saveSessionSchema(deps.sessions, edited);
    runApplicationJob(jobs, job.id, edited, llm, root, existing, carried)
      .then(() => {
        const finished = jobs.get(job.id);
        if (finished !== undefined) persist(finished, edited);
      })
      .catch((cause) => {
        const failed: ApplicationJob = { ...(jobs.get(job.id) ?? job), status: 'failed', error: { phase: 'unexpected', message: `unexpected: ${String(cause)}` } };
        jobs.set(failed);
        persist(failed, edited);
      });
    return c.json({ id: job.id, status: job.status, added: edit.add.length, removed: edit.remove.length }, 202);
  });

  // Continue a half-built project: a run that failed during generation keeps
  // the component files it had written (partialFiles); this starts a new run
  // that reuses them and generates only the rest.
  app.post('/application-jobs/:id/continue', async (c) => {
    if (deps.llm === null) {
      return c.json({ error: 'no LLM provider configured (missing API key)' }, 503);
    }
    const llm = deps.llm;
    const id = c.req.param('id');
    const parent = findJob(id);
    const schema = runs?.get(id)?.job.schema;
    if (parent === undefined || schema === undefined) {
      return c.json({ error: `application job ${id} is not a saved run` }, 404);
    }
    if (parent.status !== 'failed' || parent.result !== undefined) {
      return c.json({ error: 'only a run that stopped during generation can be continued' }, 409);
    }
    const partial = parent.partialFiles ?? [];
    if (partial.length === 0) {
      return c.json({ error: 'this run saved no components before it stopped - use Generate Application to start again' }, 409);
    }

    const capacity = atCapacity(jobs, c);
    if (capacity !== null) return capacity;

    const parentRoot = join(deps.generationRoot, parent.id);
    const existing = await Promise.all(partial.map(async (file) => ({ path: file.path, contents: await readGeneratedFile(parentRoot, file.path) })));
    const job = jobs.create({ sessionId: parent.sessionId, kind: 'continue', parentId: parent.id });
    const root = join(deps.generationRoot, job.id);
    runApplicationJob(jobs, job.id, schema, llm, root, existing)
      .then(() => {
        const finished = jobs.get(job.id);
        if (finished !== undefined) persist(finished, schema);
      })
      .catch((cause) => {
        // From the job's latest state, not its starting one: that keeps the
        // partialFiles a crash would otherwise throw away.
        const failed: ApplicationJob = { ...(jobs.get(job.id) ?? job), status: 'failed', error: { phase: 'unexpected', message: `unexpected: ${String(cause)}` } };
        jobs.set(failed);
        persist(failed, schema);
      });

    return c.json({ id: job.id, status: job.status, reused: existing.length }, 202);
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
        // From the job's latest state, not its starting one: that keeps the
        // partialFiles a crash would otherwise throw away.
        const failed: ApplicationJob = { ...(jobs.get(job.id) ?? job), status: 'failed', error: { phase: 'unexpected', message: `unexpected: ${String(cause)}` } };
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
    // The verified project plus what a person needs to open its UI (index.html,
    // Vite, README) and, when the plan is on record, the Student Project Pack.
    const saved = runs?.get(id)?.job;
    const scaffolded = withRunScaffold(entries, saved?.schema.title);
    const zip = buildZipArchive(
      saved === undefined ? scaffolded : withProjectPack(scaffolded, { schema: saved.schema, verification: packVerification(job.result) }),
    );

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

  // Page sync: after a page's form is saved from the Page Builder, generate the
  // backend API and database store that receive it (page-sync.ts), then build,
  // repair and verify - saved as a new run, the parent left untouched.
  app.post('/application-jobs/:id/pages/sync', async (c) => {
    if (deps.llm === null) {
      return c.json({ error: 'no LLM provider configured (missing API key)' }, 503);
    }
    const llm = deps.llm;
    const id = c.req.param('id');
    const parent = findJob(id);
    const schema = runs?.get(id)?.job.schema;
    if (runs === undefined || parent?.result === undefined || schema === undefined) {
      return c.json({ error: `application job ${id} is not a saved, finished run` }, 404);
    }
    const body: unknown = await c.req.json().catch(() => null);
    const path = typeof body === 'object' && body !== null ? (body as { path?: unknown }).path : undefined;
    if (typeof path !== 'string') return c.json({ error: 'expected { path }' }, 400);
    const stored = runs.getPageLayout(id, path);
    const layout = stored === undefined ? null : parsePageLayout({ layout: stored.layout });
    if (layout === null) {
      return c.json({ error: `save ${path} from the Page Builder first - only a saved design can be synced` }, 409);
    }
    const planned = planPageSync(schema, layout);
    if (!planned.ok) {
      const message = planned.error.reason === 'no-form-fields' ? 'this page has no inputs, so there is no data to store' : planned.error.message;
      return c.json({ error: message }, 400);
    }

    const capacity = atCapacity(jobs, c);
    if (capacity !== null) return capacity;

    const job = jobs.create({ sessionId: parent.sessionId, kind: 'page-sync', parentId: parent.id });
    const root = join(deps.generationRoot, job.id);
    const source = { parentRoot: join(deps.generationRoot, parent.id), parentFiles: parent.result.files, root };
    // Edited pages stay editable in the new run.
    for (const page of runs.listPageLayouts(id)) runs.savePageLayout({ ...page, runId: job.id });

    runPageSyncJob(jobs, job.id, planned.value, llm, source)
      .then(() => {
        const finished = jobs.get(job.id);
        if (finished !== undefined) persist(finished, planned.value.schema);
      })
      .catch((cause) => {
        // From the job's latest state, not its starting one: that keeps the
        // partialFiles a crash would otherwise throw away.
        const failed: ApplicationJob = { ...(jobs.get(job.id) ?? job), status: 'failed', error: { phase: 'unexpected', message: `unexpected: ${String(cause)}` } };
        jobs.set(failed);
        persist(failed, planned.value.schema);
      });

    return c.json({ id: job.id, status: job.status, fields: planned.value.fields }, 202);
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

/** The checks a finished run passed, as the project report states them. */
function packVerification(result: ApplicationJobResult): PackVerification {
  return {
    buildOk: result.build.installOk && result.build.buildOk,
    architectureViolations: result.unresolvedViolations.length,
    securityFindings: result.unresolvedServiceLocatorFindings.length,
    repairRounds: result.regenerationLog.length,
  };
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
  existingFiles: readonly GeneratedFile[] = [],
  carriedFiles: readonly GeneratedFile[] = [],
): Promise<void> {
  const current = store.get(jobId);
  if (current === undefined) return;
  store.set({ ...current, status: 'running' });

  // Every component file is written the moment it exists, so a run that
  // stops halfway (a provider's daily quota, a crash) keeps what it made.
  const saved: GeneratedFile[] = [];
  const onComponentFile = async (file: GeneratedFile): Promise<void> => {
    saved.push(file);
    await writeProjectFiles(root, [file], false);
    const latest = store.get(jobId);
    if (latest !== undefined) store.set({ ...latest, partialFiles: summarise(saved) });
  };

  const generated = await generateAndVerifyProject(schema, {
    provider: llm.provider,
    cache: llm.cache,
    // Generating a real application is a deliberate, user-triggered action,
    // not a repeated measurement of an unchanging repo (see skipCache's own
    // doc comment, component-codegen.ts) - every job asks the provider
    // fresh for every component, first attempt and retry alike.
    skipCache: true,
    root,
    existingFiles,
    carriedFiles,
    onComponentFile,
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
    unresolvedServiceLocatorFindings: detectServiceLocatorEvasion(built.value.files, planConstraints(schema)),
    build: built.value.build,
  });
}

/**
 * Page sync's worker: the parent run's files, plus the page's store and API
 * generated from its form (page-sync.ts), then the same build-repair and
 * Blueprint verification every generation gets.
 */
async function runPageSyncJob(
  store: ApplicationJobStore,
  jobId: string,
  plan: PageSyncPlan,
  llm: Llm,
  source: { readonly parentRoot: string; readonly parentFiles: readonly FileSummary[]; readonly root: string },
): Promise<void> {
  const current = store.get(jobId);
  if (current === undefined) return;
  store.set({ ...current, status: 'running', phase: 'generating' });

  const parentFiles = await Promise.all(
    source.parentFiles.map(async (file) => ({ path: file.path, contents: await readGeneratedFile(source.parentRoot, file.path) })),
  );
  const synced = await generatePageSyncFiles(plan, parentFiles, { provider: llm.provider, cache: llm.cache, skipCache: true });
  await llm.cache.flush();
  if (!synced.ok) {
    fail(store, jobId, { phase: 'generate-application', ...synced.error });
    return;
  }
  await writeProjectFiles(source.root, synced.value, true);

  const built = await installBuildAndRepair({
    schema: plan.schema,
    llm,
    root: source.root,
    files: synced.value,
    onPhase: (phase) => setPhase(store, jobId, phase),
  });
  if (!built.ok) {
    fail(store, jobId, { phase: 'generate-application', ...built.error });
    return;
  }

  setPhase(store, jobId, 'reverifying');
  const verified = await verifyGeneratedProject(source.root, plan.schema);
  if (!verified.ok) {
    fail(store, jobId, { phase: 'generate-application', ...verified.error });
    return;
  }

  finish(store, jobId, {
    files: summarise(built.value.files),
    regenerationLog: built.value.regenerationLog,
    unresolvedViolations: verified.value,
    unresolvedServiceLocatorFindings: detectServiceLocatorEvasion(built.value.files, planConstraints(plan.schema)),
    build: built.value.build,
  });
}

// ---- import and component edits ---------------------------------------------

type ImportSource = { readonly kind: 'local'; readonly path: string } | { readonly kind: 'git'; readonly url: string; readonly branch: string };

/** An empty plan that names what failed to import, so the failure has a session to be listed under. */
function failedImportSchema(sessionId: string, source: ImportSource): ValidatedProjectSchema | null {
  const where = source.kind === 'local' ? source.path : source.url;
  const name = source.kind === 'local' ? basename(source.path) : source.url.replace(/\.git$/, '').split('/').pop() ?? source.url;
  const empty = { components: [], dependsOn: [] };
  const validated = validateProjectSchema({
    sessionId,
    title: `Import failed: ${name}`,
    originalPrompt: `Imported from ${where}`,
    domains: { frontend: empty, backend: empty, database: empty, security: empty },
    constraints: [],
    provenance: 'STATED',
  });
  return validated.ok ? validated.value : null;
}

function parseImportSource(body: unknown): ImportSource | string {
  if (typeof body !== 'object' || body === null) return 'expected { kind: "local", path } or { kind: "git", url, branch? }';
  const record = body as Record<string, unknown>;
  if (record['kind'] === 'local' && typeof record['path'] === 'string' && record['path'].trim() !== '') return { kind: 'local', path: record['path'].trim() };
  if (record['kind'] === 'git' && typeof record['url'] === 'string') {
    const branch = typeof record['branch'] === 'string' ? record['branch'].trim() : '';
    const validBranch = validateBranch(branch);
    if (!validBranch.ok) return validBranch.error;
    return { kind: 'git', url: record['url'].trim(), branch: validBranch.value };
  }
  return 'expected { kind: "local", path } or { kind: "git", url, branch? }';
}

interface ImportContext {
  readonly sessionId: string;
  readonly root: string;
  readonly cloneRoot: string;
  readonly sessions: WorkflowSessionsStore;
}

/** Clone or read, rebuild the plan, save the session, then install, build and check - no model involved. */
async function runImportJob(store: ApplicationJobStore, jobId: string, source: ImportSource, context: ImportContext): Promise<ValidatedProjectSchema | null> {
  const current = store.get(jobId);
  if (current === undefined) return null;
  store.set({ ...current, status: 'running', phase: 'generating' });
  const pipelineError = (message: string): null => {
    fail(store, jobId, { phase: 'generate-application', reason: 'pipeline-error', message });
    return null;
  };

  let directory = source.kind === 'local' ? source.path : '';
  let title = source.kind === 'local' ? basename(source.path) : '';
  if (source.kind === 'git') {
    const parsed = parseGitUrl(source.url);
    if (!parsed.ok) return pipelineError(parsed.error);
    directory = cloneDirectoryFor(context.cloneRoot, parsed.value);
    const cloned = await cloneRepository(parsed.value.url, directory, source.branch === '' ? {} : { branch: source.branch });
    if (!cloned.ok) return pipelineError(cloned.error);
    directory = cloned.value.directory;
    title = parsed.value.url.replace(/\.git$/, '').split('/').pop() ?? 'Imported project';
  }

  const files = await readProjectFiles(directory);
  const where = source.kind === 'local' ? source.path : source.url;
  const imported = schemaFromProjectFiles(files, { sessionId: context.sessionId, title, prompt: `Imported from ${where}` });
  if (!imported.ok) return pipelineError(imported.error);
  const schema = imported.value.schema;
  saveSessionSchema(context.sessions, schema, `Imported from ${where}`);

  await writeProjectFiles(context.root, files, true);
  setPhase(store, jobId, 'installing');
  const install = await runCommand('npm', ['install', '--no-audit', '--no-fund'], context.root);
  let build = { ok: false, output: '' };
  if (install.ok) {
    setPhase(store, jobId, 'building');
    build = await runCommand('npm', ['run', 'build'], context.root);
  }
  setPhase(store, jobId, 'reverifying');
  const verified = await verifyGeneratedProject(context.root, schema);
  finish(store, jobId, {
    files: summarise(files),
    regenerationLog: [],
    unresolvedViolations: verified.ok ? verified.value : [],
    unresolvedServiceLocatorFindings: detectServiceLocatorEvasion(files, planConstraints(schema)),
    build: { installOk: install.ok, buildOk: install.ok && build.ok, ...(install.ok && build.ok ? {} : { failureOutput: install.ok ? build.output : install.output }) },
  });
  return schema;
}

/** The session is what the sidebar and Workflow graph show - kept in step with the plan a run was made from. */
function saveSessionSchema(sessions: WorkflowSessionsStore | undefined, schema: ValidatedProjectSchema, prompt?: string): void {
  if (sessions === undefined) return;
  const existing = sessions.get(schema.sessionId);
  const compiled = compileDomainConstraints(schema);
  if (existing !== undefined) {
    sessions.updatePlan(schema.sessionId, { schema, prohibitions: compiled.prohibitions, permissions: compiled.permissions });
    return;
  }
  sessions.save({
    id: schema.sessionId,
    title: schema.title,
    prompt: prompt ?? schema.originalPrompt,
    createdAt: new Date().toISOString(),
    schema,
    prohibitions: compiled.prohibitions,
    permissions: compiled.permissions,
  });
}

interface ComponentEdit {
  readonly add: readonly { readonly domain: DomainName; readonly name: string; readonly purpose: string }[];
  readonly remove: readonly { readonly domain: DomainName; readonly name: string }[];
}

function parseComponentEdit(body: unknown): ComponentEdit | string {
  if (typeof body !== 'object' || body === null) return 'expected { add: [{ domain, name, purpose }], remove: [{ domain, name }] }';
  const record = body as { add?: unknown; remove?: unknown };
  const isDomain = (value: unknown): value is DomainName => typeof value === 'string' && (DOMAIN_NAMES as readonly string[]).includes(value);
  const add: { domain: DomainName; name: string; purpose: string }[] = [];
  const remove: { domain: DomainName; name: string }[] = [];
  for (const item of Array.isArray(record.add) ? record.add : []) {
    const entry = item as Record<string, unknown>;
    if (!isDomain(entry['domain']) || typeof entry['name'] !== 'string' || entry['name'].trim() === '' || typeof entry['purpose'] !== 'string' || entry['purpose'].trim() === '') {
      return 'every added component needs a domain, a name and a purpose';
    }
    add.push({ domain: entry['domain'], name: entry['name'].trim(), purpose: entry['purpose'].trim() });
  }
  for (const item of Array.isArray(record.remove) ? record.remove : []) {
    const entry = item as Record<string, unknown>;
    if (!isDomain(entry['domain']) || typeof entry['name'] !== 'string') return 'every removed component needs a domain and a name';
    remove.push({ domain: entry['domain'], name: entry['name'] });
  }
  if (add.length === 0 && remove.length === 0) return 'nothing to change';
  return { add, remove };
}

/** The files the removed components occupied. */
function removedPaths(schema: ValidatedProjectSchema, edit: ComponentEdit): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const { domain, name } of edit.remove) {
    const component = schema.domains[domain].components.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (component !== undefined) paths.add(componentTargetPath(domain, component));
  }
  return paths;
}

function editSchemaComponents(schema: ValidatedProjectSchema, edit: ComponentEdit): ValidatedProjectSchema | string {
  const domains = { ...schema.domains };
  for (const domain of DOMAIN_NAMES) {
    const removing = new Set(edit.remove.filter((r) => r.domain === domain).map((r) => r.name.toLowerCase()));
    let components = schema.domains[domain].components.filter((component) => !removing.has(component.name.toLowerCase()));
    for (const added of edit.add.filter((a) => a.domain === domain)) {
      if (components.some((component) => component.name.toLowerCase() === added.name.toLowerCase())) return `${domain} already has a component called "${added.name}"`;
      components = [...components, { id: componentId(domain, added.name, added.purpose), name: added.name, purpose: added.purpose }];
    }
    domains[domain] = { ...schema.domains[domain], components };
  }
  const validated = validateProjectSchema({ ...schema, domains });
  return validated.ok ? validated.value : `the edited plan is not valid: ${JSON.stringify(validated.error.slice(0, 3))}`;
}
