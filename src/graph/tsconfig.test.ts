import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadTsconfig } from './tsconfig.js';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vibe-tsconfig-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(name: string, value: unknown): Promise<void> {
  await writeFile(join(root, name), JSON.stringify(value), 'utf8');
}

describe('loadTsconfig', () => {
  it('reads an extends array (TypeScript 5.0), taking each field from the configs that set it', async () => {
    await write('base-url.json', { compilerOptions: { baseUrl: 'src' } });
    await write('aliases.json', { compilerOptions: { paths: { '@lib/*': ['lib/*'] } } });
    await write('tsconfig.json', { extends: ['./base-url.json', './aliases'] });

    const loaded = await loadTsconfig(root, 'tsconfig.json');
    expect(loaded.baseUrl).toBe('src');
    expect(loaded.paths.get('@lib/*')).toEqual(['lib/*']);
  });

  it('lets a later entry of the array override an earlier one', async () => {
    await write('first.json', { compilerOptions: { baseUrl: 'one' } });
    await write('second.json', { compilerOptions: { baseUrl: 'two' } });
    await write('tsconfig.json', { extends: ['./first.json', './second.json'] });

    expect((await loadTsconfig(root, 'tsconfig.json')).baseUrl).toBe('two');
  });
});
