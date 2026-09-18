import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createApplicationJobStore,
  createGenerationRoutes,
  type ApplicationJob,
  type ApplicationJobStore,
  type GenerationRunsStore,
} from './generation-api.js';
import { createApplicationRunsStore } from '../store/application-runs-store.js';
import { databasePathFor, openDatabase, type BlueprintDatabase } from '../store/database.js';
import { validateProjectSchema } from '../workflow/validate-project-schema.js';
import { componentId, type ValidatedProjectSchema } from '../types/project-schema.js';
import type { CompletionProvider } from '../llm/provider.js';
import type { CachedLabel, LabelCache } from '../llm/cache.js';
import type { PageLayout } from '../generate/canvas-layout.js';

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

const neverCalled: CompletionProvider = {
  name: 'stub',
  model: 'stub-model',
  complete: async () => {
    throw new Error('the provider must not be called by these routes');
  },
};

function schemaWithOnePage(): ValidatedProjectSchema {
  const validated = validateProjectSchema({
    sessionId: 'session-runs-test',
    title: 'Runs test',
    originalPrompt: 'irrelevant',
    domains: {
      frontend: {
        components: [{ id: componentId('frontend', 'Product Catalog', 'product-catalog'), name: 'Product Catalog', purpose: 'lists products' }],
        dependsOn: [],
      },
      backend: { components: [], dependsOn: [] },
      database: { components: [], dependsOn: [] },
      security: { components: [], dependsOn: [] },
    },
    constraints: [],
    provenance: 'STATED',
  });
  if (!validated.ok) throw new Error('fixture schema invalid');
  return validated.value;
}

const PAGE_PATH = 'frontend/src/pages/product-catalog.tsx';
const ORIGINAL_PAGE = [
  'export function ProductCatalog(): JSX.Element {',
  '  return (<div><h1>Product Catalog</h1><button>Add to cart</button></div>);',
  '}',
  '',
].join('\n');

/** A finished job with one page on disk, exactly as a real run leaves it - written through the store and saved as a run. */
async function finishedRun(
  jobs: ApplicationJobStore,
  runs: GenerationRunsStore,
  generationRoot: string,
  build: { readonly installOk: boolean; readonly buildOk: boolean },
): Promise<ApplicationJob> {
  const schema = schemaWithOnePage();
  const created = jobs.create({ sessionId: schema.sessionId, kind: 'generate' });
  const job: ApplicationJob = {
    ...created,
    status: 'succeeded',
    result: {
      files: [{ path: PAGE_PATH, bytes: Buffer.byteLength(ORIGINAL_PAGE) }],
      regenerationLog: [],
      unresolvedViolations: [],
      unresolvedServiceLocatorFindings: [],
      build: { ...build, ...(build.buildOk ? {} : { failureOutput: `${PAGE_PATH}(2,3): error TS1005: ',' expected.` }) },
    },
  };
  jobs.set(job);
  const full = join(generationRoot, job.id, ...PAGE_PATH.split('/'));
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, ORIGINAL_PAGE, 'utf8');
  runs.save({ id: job.id, sessionId: job.sessionId, kind: 'generate', parentId: null, status: 'succeeded', createdAt: job.createdAt, job: { job, schema } });
  return job;
}

describe('saved application runs', () => {
  let root: string;
  let db: BlueprintDatabase;
  let runs: GenerationRunsStore;
  let jobs: ApplicationJobStore;
  let app: ReturnType<typeof createGenerationRoutes>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vibe-generation-runs-'));
    db = openDatabase(databasePathFor(root));
    runs = createApplicationRunsStore(db);
    jobs = createApplicationJobStore();
    app = createGenerationRoutes({ llm: { provider: neverCalled, cache: memoryCache() }, generationRoot: join(root, 'generated'), jobs, runs });
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('serves a saved run by id and as a download after the in-memory job is gone (a restart)', async () => {
    const job = await finishedRun(jobs, runs, join(root, 'generated'), { installOk: true, buildOk: true });
    const restarted = createGenerationRoutes({ llm: null, generationRoot: join(root, 'generated'), jobs: createApplicationJobStore(), runs });

    const fetched = await restarted.request(`/application-jobs/${job.id}`);
    expect(fetched.status).toBe(200);
    expect(((await fetched.json()) as ApplicationJob).result?.build.buildOk).toBe(true);

    const download = await restarted.request(`/application-jobs/${job.id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/zip');
  });

  it('lists a session\'s runs with the latest one\'s full job, and the latest run per session for the sidebar', async () => {
    const job = await finishedRun(jobs, runs, join(root, 'generated'), { installOk: true, buildOk: false });

    const perSession = await app.request('/sessions/session-runs-test/application-runs');
    const body = (await perSession.json()) as { runs: { id: string }[]; latest: ApplicationJob | null };
    expect(body.runs.map((run) => run.id)).toEqual([job.id]);
    expect(body.latest?.id).toBe(job.id);

    const latest = await app.request('/application-runs/latest');
    expect(await latest.json()).toEqual({ runs: [{ sessionId: 'session-runs-test', runId: job.id, status: 'succeeded', buildOk: false }] });

    const nothing = (await (await app.request('/sessions/unknown/application-runs')).json()) as { runs: unknown[]; latest: null };
    expect(nothing).toEqual({ runs: [], latest: null });
  });

  describe('repair', () => {
    it('refuses to repair a run that already builds - a full regeneration is a different, costlier action', async () => {
      const job = await finishedRun(jobs, runs, join(root, 'generated'), { installOk: true, buildOk: true });
      const response = await app.request(`/application-jobs/${job.id}/repair`, { method: 'POST', body: '{}' });
      expect(response.status).toBe(409);
    });

    it('404s for a job that was never finished', async () => {
      const response = await app.request('/application-jobs/nope/repair', { method: 'POST', body: '{}' });
      expect(response.status).toBe(404);
    });

    it('accepts a failing run and starts a new repair job that names its parent', async () => {
      const job = await finishedRun(jobs, runs, join(root, 'generated'), { installOk: true, buildOk: false });
      const response = await app.request(`/application-jobs/${job.id}/repair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: 'keep the heading' }),
      });
      expect(response.status).toBe(202);
      const { id } = (await response.json()) as { id: string };
      expect(jobs.get(id)).toMatchObject({ kind: 'repair', parentId: job.id, sessionId: 'session-runs-test' });

      // The copied project has no package.json, so npm's own failure output
      // carries no tsc diagnostics: nothing is attributable, the provider is
      // never called, and the job still reaches a terminal state and is saved.
      const deadline = Date.now() + 60_000;
      let repair = jobs.get(id);
      while (repair !== undefined && repair.status !== 'succeeded' && repair.status !== 'failed' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        repair = jobs.get(id);
      }
      expect(repair?.status).toBe('succeeded');
      expect(repair?.result?.build.buildOk).toBe(false);
      expect(runs.get(id)?.parentId).toBe(job.id);
      expect(runs.listForSession('session-runs-test').map((run) => run.id)).toEqual([id, job.id]);
    }, 70_000);
  });

  describe('pages', () => {
    it('lists the run\'s frontend pages as extracted layouts named after their component', async () => {
      const job = await finishedRun(jobs, runs, join(root, 'generated'), { installOk: true, buildOk: true });
      const response = await app.request(`/application-jobs/${job.id}/pages`);
      expect(response.status).toBe(200);
      const { pages } = (await response.json()) as { pages: { path: string; pageName: string; edited: boolean; layout: PageLayout }[] };
      expect(pages).toHaveLength(1);
      expect(pages[0]?.path).toBe(PAGE_PATH);
      expect(pages[0]?.pageName).toBe('Product Catalog');
      expect(pages[0]?.edited).toBe(false);
      expect(pages[0]?.layout.elements.map((e) => [e.type, e.label])).toEqual([
        ['heading', 'Product Catalog'],
        ['button', 'Add to cart'],
      ]);
    });

    it('saves an edited layout as the page\'s real file, keeps the original, and restores it on request', async () => {
      const job = await finishedRun(jobs, runs, join(root, 'generated'), { installOk: true, buildOk: true });
      const layout: PageLayout = {
        id: 'x',
        pageName: 'Product Catalog',
        elements: [{ id: 'el-1', type: 'heading', x: 40, y: 40, width: 400, height: 56, label: 'Edited heading', colorToken: 'primary' }],
      };

      const saved = await app.request(`/application-jobs/${job.id}/pages`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layout }),
      });
      expect(saved.status).toBe(200);
      const onDisk = await readFile(join(root, 'generated', job.id, ...PAGE_PATH.split('/')), 'utf8');
      expect(onDisk).toContain('Edited heading');
      expect(onDisk).toContain('export const ProductCatalog: FC');

      const listed = (await (await app.request(`/application-jobs/${job.id}/pages`)).json()) as { pages: { edited: boolean; layout: PageLayout }[] };
      expect(listed.pages[0]?.edited).toBe(true);
      expect(listed.pages[0]?.layout).toEqual(layout);

      const restored = await app.request(`/application-jobs/${job.id}/pages/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: PAGE_PATH }),
      });
      expect(restored.status).toBe(200);
      expect(await readFile(join(root, 'generated', job.id, ...PAGE_PATH.split('/')), 'utf8')).toBe(ORIGINAL_PAGE);
    });

    it('refuses a layout whose page name would compile to a file that is not one of the run\'s pages', async () => {
      const job = await finishedRun(jobs, runs, join(root, 'generated'), { installOk: true, buildOk: true });
      const response = await app.request(`/application-jobs/${job.id}/pages`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layout: { id: 'x', pageName: 'Something Else', elements: [] } }),
      });
      expect(response.status).toBe(400);
    });
  });
});
