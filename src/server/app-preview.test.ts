import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPreviewManager, type PreviewManager, type PreviewStatus } from './app-preview.js';

// A backend that is already "built": the stubbed npm steps do nothing, and
// dist/backend/src/index.js is a tiny server on the PORT the preview chose.
const backendOnly = [
  { path: 'package.json', contents: '{"name":"app","scripts":{"build":"tsc"}}' },
  { path: 'backend/src/index.ts', contents: '' },
  {
    path: 'dist/backend/src/index.js',
    contents: "require('node:http').createServer((q, s) => s.end('books')).listen(Number(process.env.PORT), '127.0.0.1');",
  },
];
const npmOk = async (): Promise<{ ok: boolean; output: string }> => ({ ok: true, output: '' });

let root = '';
let manager: PreviewManager | undefined;

afterEach(async () => {
  manager?.stopAll();
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (root !== '') await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
});

async function settled(preview: PreviewManager, runId: string): Promise<PreviewStatus> {
  for (let i = 0; i < 100; i += 1) {
    const status = preview.status(runId);
    if (status.state !== 'starting') return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return preview.status(runId);
}

describe('createPreviewManager', () => {
  it('starts the backend on a free loopback port, reports its address, and stops it', async () => {
    root = await mkdtemp(join(tmpdir(), 'preview-'));
    manager = createPreviewManager({ previewRoot: root, run: npmOk, readyTimeoutMs: 15_000 });
    expect(manager.start('run-1', backendOnly).state).toBe('starting');

    const status = await settled(manager, 'run-1');
    expect(status).toMatchObject({ state: 'running' });
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(`${status.url}/`)).text()).toBe('books');

    manager.stop('run-1');
    expect(manager.status('run-1').state).toBe('stopped');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await expect(fetch(`${status.url}/`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
  }, 30_000);

  it('reports a failed install with npm output, and starts nothing', async () => {
    root = await mkdtemp(join(tmpdir(), 'preview-'));
    const failing = async (): Promise<{ ok: boolean; output: string }> => ({ ok: false, output: 'ERESOLVE could not resolve' });
    manager = createPreviewManager({ previewRoot: root, run: failing });
    manager.start('run-2', backendOnly);

    const status = await settled(manager, 'run-2');
    expect(status.state).toBe('failed');
    expect(status.error).toContain('npm install failed');
    expect(status.error).toContain('ERESOLVE');
  });

  it('runs one preview at a time: starting another stops the first', async () => {
    root = await mkdtemp(join(tmpdir(), 'preview-'));
    manager = createPreviewManager({ previewRoot: root, run: npmOk, readyTimeoutMs: 15_000 });
    manager.start('first', backendOnly);
    expect((await settled(manager, 'first')).state).toBe('running');

    manager.start('second', backendOnly);
    expect(manager.status('first').state).toBe('stopped');
    expect((await settled(manager, 'second')).state).toBe('running');
  }, 30_000);

  it('knows nothing of a run it never started', () => {
    manager = createPreviewManager({ previewRoot: join(tmpdir(), 'unused') });
    expect(manager.status('never')).toEqual({ runId: 'never', state: 'stopped' });
  });
});
