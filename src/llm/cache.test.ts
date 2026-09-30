import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cachePathFor, loadLabelCache, type CachedLabel } from './cache.js';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vibe-cache-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function label(name: string): CachedLabel {
  return { label: name, description: null, model: 'test', promptTokens: 1, completionTokens: 1, createdAt: '2026-01-01T00:00:00Z' };
}

describe('label cache', () => {
  it("keeps every job's entries when several flush the same file at once", async () => {
    const caches = await Promise.all([1, 2, 3, 4].map(() => loadLabelCache(root)));
    caches.forEach((cache, index) => cache.set(`key-${index}`, label(`label-${index}`)));

    const written = await Promise.all(caches.map((cache) => cache.flush()));
    expect(written).toEqual([true, true, true, true]);

    const onDisk = JSON.parse(await readFile(cachePathFor(root), 'utf8')) as { entries: Record<string, CachedLabel> };
    expect(Object.keys(onDisk.entries).sort()).toEqual(['key-0', 'key-1', 'key-2', 'key-3']);
  });

  it('waits while another process holds the lock, then merges and writes', async () => {
    const path = cachePathFor(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.lock`, '', 'utf8');
    const cache = await loadLabelCache(root);
    cache.set('mine', label('mine'));
    const flushing = cache.flush();
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The "other process" saved an entry, then released the lock.
    await writeFile(path, JSON.stringify({ version: 1, entries: { theirs: label('theirs') } }), 'utf8');
    await rm(`${path}.lock`);
    expect(await flushing).toBe(true);
    const reloaded = await loadLabelCache(root);
    expect(reloaded.get('mine')?.label).toBe('mine');
    expect(reloaded.get('theirs')?.label).toBe('theirs');
  });

  it('clears a lock left behind by a process that died mid-flush', async () => {
    const path = cachePathFor(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.lock`, '', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    const cache = await loadLabelCache(root);
    cache.set('k', label('v'));
    expect(await cache.flush()).toBe(true);
  });

  it('round-trips an entry', async () => {
    const cache = await loadLabelCache(root);
    cache.set('k', label('hello'));
    expect(await cache.flush()).toBe(true);
    expect((await loadLabelCache(root)).get('k')?.label).toBe('hello');
  });
});
