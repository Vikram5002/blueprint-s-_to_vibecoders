import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectRoutes, RECENT_PROJECTS_SETTING_KEY, type AnalyseOptions, type ProjectJob } from './projects-api.js';
import { createContextHolder, type ContextHolder } from './context-holder.js';
import type { AnalysisContext } from './context.js';
import type { SettingsStore } from '../store/settings-store.js';
import { ok, err, type Result } from '../types/result.js';
import type { CloneOptions, CloneResult } from '../ingest/git-source.js';

/** Only `root` and `db.close` are read by the holder and these routes. */
function fakeContext(root: string): AnalysisContext & { db: { close: ReturnType<typeof vi.fn> } } {
  return { root, db: { close: vi.fn() } } as unknown as AnalysisContext & { db: { close: ReturnType<typeof vi.fn> } };
}

function memorySettings(): SettingsStore {
  const values = new Map<string, string>();
  return { get: (key) => values.get(key) ?? null, set: (key, value) => void values.set(key, value) };
}

async function waitForJob(app: ReturnType<typeof createProjectRoutes>): Promise<ProjectJob> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const job = (await (await app.request('/job')).json()) as ProjectJob;
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    if (Date.now() > deadline) throw new Error(`job stuck in ${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const post = (app: ReturnType<typeof createProjectRoutes>, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('project routes', () => {
  let dir: string;
  let home: AnalysisContext;
  let holder: ContextHolder;
  let settings: SettingsStore;
  let analysed: { root: string; options: AnalyseOptions }[];
  let cloned: { url: string; directory: string; options: CloneOptions }[];

  function routes(overrides: {
    analyse?: (root: string, options: AnalyseOptions) => Promise<Result<AnalysisContext, string>>;
    clone?: (url: string, directory: string, options: CloneOptions) => Promise<Result<CloneResult, string>>;
  } = {}) {
    return createProjectRoutes({
      holder,
      settings,
      cloneRoot: join(dir, 'clones'),
      analyse:
        overrides.analyse ??
        (async (root, options) => {
          analysed.push({ root, options });
          options.onProgress('Parsing files 1 of 1', 100);
          return ok(fakeContext(root));
        }),
      clone:
        overrides.clone ??
        (async (url, directory, options) => {
          cloned.push({ url, directory, options });
          await mkdir(directory, { recursive: true });
          return ok({ directory, commit: 'a'.repeat(40) });
        }),
      pickFolder: async () => ok(join(dir, 'picked')),
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vibe-projects-'));
    await mkdir(join(dir, 'home'));
    await mkdir(join(dir, 'other', 'src'), { recursive: true });
    await writeFile(join(dir, 'a-file.txt'), 'x', 'utf8');
    home = fakeContext(join(dir, 'home'));
    holder = createContextHolder(home);
    settings = memorySettings();
    analysed = [];
    cloned = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports the home project until another one is analysed', async () => {
    const current = (await (await routes().request('/current')).json()) as { root: string; isHome: boolean; source: { kind: string } };
    expect(current).toMatchObject({ root: join(dir, 'home'), isHome: true, source: { kind: 'home' } });
  });

  it('analyses a local folder in the background, then serves it and remembers it', async () => {
    const app = routes();
    const response = await post(app, '/analyse', { kind: 'local', path: join(dir, 'other') });
    expect(response.status).toBe(202);

    const job = await waitForJob(app);
    expect(job.status).toBe('succeeded');
    expect(holder.current().root).toBe(join(dir, 'other'));
    expect(analysed[0]?.options.modelLabels).toBe(false);

    const current = (await (await app.request('/current')).json()) as { isHome: boolean; source: { kind: string; path: string } };
    expect(current.isHome).toBe(false);
    expect(current.source).toEqual({ kind: 'local', path: join(dir, 'other') });

    const recent = (await (await app.request('/recent')).json()) as { recent: { label: string }[] };
    expect(recent.recent.map((entry) => entry.label)).toEqual([join(dir, 'other')]);
  });

  it('passes the model-naming choice through, so the default costs no API calls', async () => {
    const app = routes();
    await post(app, '/analyse', { kind: 'local', path: join(dir, 'other'), modelLabels: true });
    await waitForJob(app);
    expect(analysed[0]?.options.modelLabels).toBe(true);
  });

  it('refuses a folder that does not exist, or a file, before starting anything', async () => {
    const app = routes();
    expect((await post(app, '/analyse', { kind: 'local', path: join(dir, 'nope') })).status).toBe(400);
    expect((await post(app, '/analyse', { kind: 'local', path: join(dir, 'a-file.txt') })).status).toBe(400);
    expect(analysed).toEqual([]);
  });

  it('choosing the home folder switches straight back without re-analysing it', async () => {
    const app = routes();
    await post(app, '/analyse', { kind: 'local', path: join(dir, 'other') });
    await waitForJob(app);
    const response = await post(app, '/analyse', { kind: 'local', path: join(dir, 'home') });
    expect(response.status).toBe(200);
    expect(holder.current()).toBe(home);
    expect(analysed).toHaveLength(1);
  });

  it('clones a Git URL into one stable folder per repository, analyses the clone, and records the commit', async () => {
    const app = routes();
    const response = await post(app, '/analyse', { kind: 'git', url: 'github.com/owner/repo.git', branch: 'main' });
    expect(response.status).toBe(202);
    const job = await waitForJob(app);
    expect(job.status).toBe('succeeded');

    expect(cloned[0]?.url).toBe('https://github.com/owner/repo');
    expect(cloned[0]?.directory).toBe(join(dir, 'clones', 'github.com', 'owner', 'repo'));
    expect(cloned[0]?.options.branch).toBe('main');
    expect(analysed[0]?.root).toBe(join(dir, 'clones', 'github.com', 'owner', 'repo'));

    const current = (await (await app.request('/current')).json()) as { source: unknown };
    expect(current.source).toEqual({ kind: 'git', url: 'https://github.com/owner/repo', branch: 'main', commit: 'a'.repeat(40) });
  });

  it('refuses an unsafe or malformed Git URL or branch without cloning', async () => {
    const app = routes();
    expect((await post(app, '/analyse', { kind: 'git', url: 'git@github.com:owner/repo.git' })).status).toBe(400);
    expect((await post(app, '/analyse', { kind: 'git', url: 'https://user:tok@github.com/o/r' })).status).toBe(400);
    expect((await post(app, '/analyse', { kind: 'git', url: 'https://github.com/o/r', branch: '--upload-pack=x' })).status).toBe(400);
    expect(cloned).toEqual([]);
  });

  it('reports a failed clone in plain words and keeps serving the previous project', async () => {
    const app = routes({ clone: async () => err('Repository not found, or it is private.') });
    await post(app, '/analyse', { kind: 'git', url: 'https://github.com/o/missing' });
    const job = await waitForJob(app);
    expect(job.status).toBe('failed');
    expect(job.message).toContain('not found');
    expect(holder.current()).toBe(home);
  });

  it('drops the last progress value when an analysis fails', async () => {
    const app = routes({
      analyse: async (_root, options) => {
        options.onProgress('Parsing files 8 of 10', 80);
        return err('the parser ran out of memory');
      },
    });
    await mkdir(join(dir, 'other'), { recursive: true });
    await post(app, '/analyse', { kind: 'local', path: join(dir, 'other') });
    const job = await waitForJob(app);
    expect(job.status).toBe('failed');
    expect(job.percent).toBeUndefined();
  });

  it('refuses a second analysis while one is running', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const app = routes({
      analyse: async (root) => {
        await gate;
        return ok(fakeContext(root));
      },
    });
    expect((await post(app, '/analyse', { kind: 'local', path: join(dir, 'other') })).status).toBe(202);
    expect((await post(app, '/analyse', { kind: 'local', path: join(dir, 'other') })).status).toBe(409);
    release();
    await waitForJob(app);
  });

  it('closes the previous non-home project when switching, but never the home project', async () => {
    const first = fakeContext(join(dir, 'other'));
    const app = routes({ analyse: async () => ok(first) });
    await post(app, '/analyse', { kind: 'local', path: join(dir, 'other') });
    await waitForJob(app);
    await post(app, '/home', {});
    expect(first.db.close).toHaveBeenCalledOnce();
    expect((home.db as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
  });

  it('browses folders only, hides dot-folders, and gives the parent', async () => {
    await mkdir(join(dir, '.hidden'));
    const body = (await (await routes().request(`/browse?path=${encodeURIComponent(dir)}`)).json()) as {
      path: string;
      parent: string;
      entries: { name: string }[];
    };
    expect(body.entries.map((entry) => entry.name)).toEqual(['home', 'other']);
    expect(body.parent).not.toBe('');
  });

  it('returns the folder picked in the native dialog', async () => {
    const body = (await (await post(routes(), '/pick-folder', {})).json()) as { path: string };
    expect(body.path).toBe(join(dir, 'picked'));
  });

  it('keeps at most one recent entry per source, newest first', async () => {
    const app = routes();
    for (const target of ['other', 'home/..', 'other']) {
      await post(app, '/analyse', { kind: 'local', path: join(dir, target) });
      await waitForJob(app);
    }
    const stored = JSON.parse(settings.get(RECENT_PROJECTS_SETTING_KEY) ?? '[]') as { label: string }[];
    expect(stored.map((entry) => entry.label)).toEqual([join(dir, 'other'), dir]);
  });
});
