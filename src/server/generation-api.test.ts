import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createApplicationJobStore,
  createGenerationRoutes,
  MAX_CONCURRENT_APPLICATION_JOBS,
  type ApplicationJob,
  type ApplicationJobStore,
  type ApplicationRunPayload,
} from './generation-api.js';
import { createApplicationRunsStore } from '../store/application-runs-store.js';
import { openDatabase } from '../store/database.js';
import type { PageLayout } from '../generate/canvas-layout.js';
import { validateProjectSchema } from '../workflow/validate-project-schema.js';
import type { CompletionProvider, CompletionRequest, CompletionResult } from '../llm/provider.js';
import type { CachedLabel, LabelCache } from '../llm/cache.js';

function memoryCache(): LabelCache {
  const entries = new Map<string, CachedLabel>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => void entries.set(key, value),
    flush: async () => true,
    get size() {
      return entries.size;
    },
  };
}

function stubProvider(respond: (request: CompletionRequest) => CompletionResult): CompletionProvider {
  return { name: 'stub', model: 'stub-model', complete: async (request) => respond(request) };
}

function okCode(code: string): CompletionResult {
  return {
    ok: true,
    value: { text: JSON.stringify({ code }), model: 'stub-model', usage: { promptTokens: 1, completionTokens: 1, cachedPromptTokens: 0 } },
  };
}

/** A schema with no components at all - generateAndVerifyProject never calls the provider, never spawns npm, so this exercises the route surface fast and deterministically. */
const EMPTY_SCHEMA_CANDIDATE = {
  sessionId: 'session-generation-api-test',
  title: 'Empty test schema',
  originalPrompt: 'irrelevant for this fixture',
  domains: {
    frontend: { components: [], dependsOn: [] },
    backend: { components: [], dependsOn: [] },
    database: { components: [], dependsOn: [] },
    security: { components: [], dependsOn: [] },
  },
  constraints: [],
  provenance: 'STATED',
};

async function pollUntilTerminal(
  app: ReturnType<typeof createGenerationRoutes>,
  id: string,
  timeoutMs = 15_000,
): Promise<ApplicationJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await app.request(`/application-jobs/${id}`);
    const job = (await response.json()) as ApplicationJob;
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    if (Date.now() > deadline) {
      throw new Error(`job ${id} did not reach a terminal state within ${timeoutMs}ms (last status: ${job.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('createGenerationRoutes', () => {
  let generationRoot: string;

  beforeEach(async () => {
    generationRoot = await mkdtemp(join(tmpdir(), 'vibe-generation-api-test-'));
  });

  afterEach(async () => {
    await rm(generationRoot, { recursive: true, force: true });
  });

  it('returns 503 when no provider is configured', async () => {
    const app = createGenerationRoutes({ llm: null, generationRoot });
    const response = await app.request('/application-jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: EMPTY_SCHEMA_CANDIDATE }),
    });
    expect(response.status).toBe(503);
  });

  it('rejects a request with no schema field', async () => {
    const app = createGenerationRoutes({ llm: { provider: stubProvider(() => okCode('x')), cache: memoryCache() }, generationRoot });
    const response = await app.request('/application-jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it('rejects a schema that fails real validateProjectSchema, with rejections surfaced', async () => {
    const app = createGenerationRoutes({ llm: { provider: stubProvider(() => okCode('x')), cache: memoryCache() }, generationRoot });
    const response = await app.request('/application-jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: { not: 'a real schema' } }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; rejections: unknown[] };
    expect(body.rejections.length).toBeGreaterThan(0);
  });

  it('404s for an unknown job id', async () => {
    const app = createGenerationRoutes({ llm: { provider: stubProvider(() => okCode('x')), cache: memoryCache() }, generationRoot });
    const response = await app.request('/application-jobs/does-not-exist');
    expect(response.status).toBe(404);
  });

  it(
    'creates a job and returns 202 pending before generation finishes, then reaches succeeded for an empty schema (no components to generate, but a real npm install/build still runs)',
    async () => {
      const app = createGenerationRoutes({ llm: { provider: stubProvider(() => okCode('x')), cache: memoryCache() }, generationRoot });
      const submitted = await app.request('/application-jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schema: EMPTY_SCHEMA_CANDIDATE }),
      });
      expect(submitted.status).toBe(202);
      const { id, status } = (await submitted.json()) as { id: string; status: string };
      expect(status).toBe('pending');

      const job = await pollUntilTerminal(app, id, 60_000);
      expect(job.status).toBe('succeeded');
      if (job.status !== 'succeeded' || job.result === undefined) throw new Error('expected a result');
      // Templated files only: package.json, tsconfig.json, backend/src/index.ts - no components to generate.
      expect(job.result.files.length).toBeGreaterThan(0);
      expect(job.result.regenerationLog).toEqual([]);
      expect(job.result.unresolvedViolations).toEqual([]);
      // A real npm install + tsc build actually ran and passed.
      expect(job.result.build.installOk).toBe(true);
      expect(job.result.build.buildOk).toBe(true);
    },
    70_000,
  );

  it('a provider failure surfaces as a failed job with phase "generate-application", never reaching install/build', async () => {
    const validated = validateProjectSchema({
      ...EMPTY_SCHEMA_CANDIDATE,
      domains: {
        ...EMPTY_SCHEMA_CANDIDATE.domains,
        backend: { components: [{ id: 'c1', name: 'Thing', purpose: 'x' }], dependsOn: [] },
      },
    });
    if (!validated.ok) throw new Error('fixture schema invalid');

    const app = createGenerationRoutes({
      llm: { provider: stubProvider(() => ({ ok: false, error: { kind: 'refused', message: 'simulated failure' } })), cache: memoryCache() },
      generationRoot,
    });
    const submitted = await app.request('/application-jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: validated.value }),
    });
    const { id } = (await submitted.json()) as { id: string };

    const job = await pollUntilTerminal(app, id);
    expect(job.status).toBe('failed');
    expect(job.error?.phase).toBe('generate-application');
  });

  it('409s a download request for a job with no result yet', async () => {
    const store: ApplicationJobStore = createApplicationJobStore();
    const pendingJob = store.create();
    const app = createGenerationRoutes({ llm: { provider: stubProvider(() => okCode('x')), cache: memoryCache() }, generationRoot, jobs: store });
    const response = await app.request(`/application-jobs/${pendingJob.id}/download`);
    expect(response.status).toBe(409);
  });

  it('downloads a finished run with its Student Project Pack when the plan is on record', async () => {
    const schema = validateProjectSchema({
      ...EMPTY_SCHEMA_CANDIDATE,
      title: 'Campus Quiz',
      domains: {
        ...EMPTY_SCHEMA_CANDIDATE.domains,
        backend: { components: [{ id: 'quiz-api', name: 'Quiz API', purpose: 'Serves questions.' }], dependsOn: [] },
      },
    });
    if (!schema.ok) throw new Error('fixture schema failed validation');
    const files = {
      'backend/src/index.ts': "import { router as quizApi } from './routes/quiz-api';\napp.use('/api/quiz-api', quizApi);",
      'backend/src/routes/quiz-api.ts': "router.get('/questions', h);",
    };
    const store = createApplicationJobStore();
    const job: ApplicationJob = {
      ...store.create({ sessionId: schema.value.sessionId }),
      status: 'succeeded',
      result: {
        files: Object.entries(files).map(([path, contents]) => ({ path, bytes: contents.length })),
        regenerationLog: [],
        unresolvedViolations: [],
        unresolvedServiceLocatorFindings: [],
        build: { installOk: true, buildOk: true },
      },
    };
    store.set(job);
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(join(generationRoot, job.id, dirname(path)), { recursive: true });
      await writeFile(join(generationRoot, job.id, path), contents);
    }
    const runs = createApplicationRunsStore<ApplicationRunPayload, PageLayout>(openDatabase(':memory:'));
    runs.save({ id: job.id, sessionId: job.sessionId, kind: 'generate', parentId: null, status: 'succeeded', createdAt: job.createdAt, job: { job, schema: schema.value } });

    const app = createGenerationRoutes({ llm: null, generationRoot, jobs: store, runs });
    const response = await app.request(`/application-jobs/${job.id}/download`);
    // Stored, not compressed (zip.ts): the entries can be read straight out of the archive bytes.
    const archive = Buffer.from(await response.arrayBuffer()).toString('utf8');

    expect(response.status).toBe(200);
    expect(archive).toContain('docs/PROJECT-REPORT.md');
    expect(archive).toContain('# Campus Quiz - Project Report');
    expect(archive).toContain('| GET | `/api/quiz-api/questions` | `backend/src/routes/quiz-api.ts` |');
    expect(archive).toContain('| TypeScript build of the whole project | Passed |');
  });

  it('404s a download request for an unknown job', async () => {
    const app = createGenerationRoutes({ llm: { provider: stubProvider(() => okCode('x')), cache: memoryCache() }, generationRoot });
    const response = await app.request('/application-jobs/does-not-exist/download');
    expect(response.status).toBe(404);
  });

  it('rejects a new job at capacity with 503 + Retry-After', async () => {
    const stuckProvider = stubProvider(() => new Promise(() => {}) as unknown as CompletionResult);
    const schemaWithOneComponent = validateProjectSchema({
      ...EMPTY_SCHEMA_CANDIDATE,
      domains: {
        ...EMPTY_SCHEMA_CANDIDATE.domains,
        backend: { components: [{ id: 'c1', name: 'Thing', purpose: 'x' }], dependsOn: [] },
      },
    });
    if (!schemaWithOneComponent.ok) throw new Error('fixture schema invalid');

    const app = createGenerationRoutes({ llm: { provider: stuckProvider, cache: memoryCache() }, generationRoot });

    for (let i = 0; i < MAX_CONCURRENT_APPLICATION_JOBS; i += 1) {
      const response = await app.request('/application-jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schema: schemaWithOneComponent.value }),
      });
      expect(response.status).toBe(202);
    }

    const rejected = await app.request('/application-jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: schemaWithOneComponent.value }),
    });
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('Retry-After')).toBeTruthy();
  });
});
