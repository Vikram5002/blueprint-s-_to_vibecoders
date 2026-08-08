import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { walkRepository } from '../ingest/walk.js';
import { parseRepository } from '../parser/parse-repository.js';
import { resolveRepository } from './resolve.js';
import type { ResolvedImport } from '../types/resolution.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** Walks, parses and resolves a fixture repo, keyed by importing file. */
async function resolveFixture(name: string): Promise<Map<string, ResolvedImport[]>> {
  const root = `${FIXTURES}${name}`;

  const walked = await walkRepository({ root });
  if (!walked.ok) throw new Error(walked.error.message);

  const parsed = await parseRepository({ files: walked.value.files });
  if (!parsed.ok) throw new Error(parsed.error.message);

  const resolved = await resolveRepository({ root, files: parsed.value.files });

  const byFile = new Map<string, ResolvedImport[]>();
  for (const item of resolved.imports) {
    const list = byFile.get(item.record.evidence.file) ?? [];
    list.push(item);
    byFile.set(item.record.evidence.file, list);
  }
  return byFile;
}

function pick(all: Map<string, ResolvedImport[]>, file: string, specifier: string): ResolvedImport {
  const found = all.get(file)?.find((item) => item.record.specifier === specifier);
  if (found === undefined) {
    const seen = all.get(file)?.map((i) => i.record.specifier).join(', ') ?? '(file not found)';
    throw new Error(`no import "${specifier}" in ${file}; saw: ${seen}`);
  }
  return found;
}

describe('ts-basic: relative resolution and extension inference', () => {
  let all: Map<string, ResolvedImport[]>;
  const FILE = 'src/index.ts';

  beforeAll(async () => {
    all = await resolveFixture('ts-basic');
  }, 30_000);

  it.each([
    ['./util', 'src/util.ts'],
    ['./widget', 'src/widget.tsx'],
    ['./typed', 'src/typed.d.ts'],
    ['./legacy', 'src/legacy.js'],
    ['./modern', 'src/modern.mjs'],
    ['./common', 'src/common.cjs'],
    ['./nested/deep', 'src/nested/deep.ts'],
  ])('resolves %s to %s', (specifier, target) => {
    const item = pick(all, FILE, specifier);
    expect(item.status).toBe('INTERNAL');
    expect(item.targetPath).toBe(target);
  });

  it('falls back to a directory index file', () => {
    const item = pick(all, FILE, './folder');
    expect(item.status).toBe('INTERNAL');
    expect(item.targetPath).toBe('src/folder/index.ts');
  });

  it('prefers .ts over .js for the same basename', () => {
    expect(pick(all, FILE, './ambiguous').targetPath).toBe('src/ambiguous.ts');
  });

  it('prefers a file over a directory of the same name', () => {
    expect(pick(all, FILE, './both-dir').targetPath).toBe('src/both-dir.ts');
  });

  it('resolves an explicit .js extension that exists on disk', () => {
    expect(pick(all, FILE, './with-ext.js').targetPath).toBe('src/with-ext.js');
  });

  it('maps a NodeNext ./x.js specifier onto x.ts', () => {
    // This project imports this way throughout; missing it would score 0% on ourselves.
    expect(pick(all, FILE, './esm-style.js').targetPath).toBe('src/esm-style.ts');
  });

  it('resolves a parent-directory specifier', () => {
    expect(pick(all, FILE, '../outside-src').targetPath).toBe('outside-src.ts');
  });

  it('records a missing relative target as unresolved, with a reason', () => {
    const item = pick(all, FILE, './does-not-exist');
    expect(item.status).toBe('UNRESOLVED');
    expect(item.reason).toBe('relative-target-missing');
    expect(item.targetPath).toBeNull();
  });

  it('distinguishes a real non-source file from a missing one', () => {
    // package.json exists but is not a source file the walker indexes. Calling
    // that "missing" would send someone hunting for a resolver bug that is not
    // there; it gets its own reason instead.
    const item = pick(all, FILE, '../package.json');
    expect(item.status).toBe('UNRESOLVED');
    expect(item.reason).toBe('target-not-in-repo');
  });

  it('classifies a bare specifier as external', () => {
    const item = pick(all, FILE, 'react');
    expect(item.status).toBe('EXTERNAL');
    expect(item.reason).toBe('npm-package');
    expect(item.externalName).toBe('react');
  });

  it('classifies node: builtins as external', () => {
    const item = pick(all, FILE, 'node:path');
    expect(item.status).toBe('EXTERNAL');
    expect(item.reason).toBe('node-builtin');
  });

  it('never reports a target the walker did not see', () => {
    for (const items of all.values()) {
      for (const item of items) {
        if (item.status === 'INTERNAL') {
          expect(item.targetPath).not.toBeNull();
          expect(item.targetPath).not.toContain('\\');
        }
      }
    }
  });
});

describe('ts-tsconfig: path aliases', () => {
  let all: Map<string, ResolvedImport[]>;
  const FILE = 'src/app.ts';

  beforeAll(async () => {
    all = await resolveFixture('ts-tsconfig');
  }, 30_000);

  it('resolves a wildcard alias to a directory index', () => {
    const item = pick(all, FILE, '@app/core');
    expect(item.status).toBe('INTERNAL');
    expect(item.targetPath).toBe('src/core/index.ts');
  });

  it('resolves a wildcard alias pointing outside src', () => {
    expect(pick(all, FILE, '@lib/helpers').targetPath).toBe('lib/helpers.ts');
  });

  it('resolves an exact (non-wildcard) alias', () => {
    expect(pick(all, FILE, '@exact').targetPath).toBe('src/exact-match.ts');
  });

  it('resolves a bare specifier through baseUrl inherited from an extends chain', () => {
    // baseUrl is declared in config/tsconfig.base.json as "../src", and must be
    // resolved relative to that file rather than to the root tsconfig.
    const item = pick(all, FILE, 'utils/thing');
    expect(item.status).toBe('INTERNAL');
    expect(item.targetPath).toBe('src/utils/thing.ts');
  });

  it('reports an alias whose target is missing as unresolved, not external', () => {
    const item = pick(all, FILE, '@app/missing-target');
    expect(item.status).toBe('UNRESOLVED');
    expect(item.reason).toBe('alias-target-missing');
  });

  it('still treats a genuine package as external', () => {
    const item = pick(all, FILE, 'express');
    expect(item.status).toBe('EXTERNAL');
    expect(item.reason).toBe('npm-package');
  });
});

describe('monorepo workspaces', () => {
  it('resolves a pnpm workspace package to its real file', async () => {
    const all = await resolveFixture('ts-monorepo');
    const FILE = 'packages/app/src/main.ts';

    const utils = pick(all, FILE, '@myorg/utils');
    expect(utils.status).toBe('INTERNAL');
    expect(utils.targetPath).toBe('packages/utils/src/index.ts');
  }, 30_000);

  it('resolves a deep import into a workspace package', async () => {
    const all = await resolveFixture('ts-monorepo');
    const item = pick(all, 'packages/app/src/main.ts', '@myorg/utils/src/sub');
    expect(item.status).toBe('INTERNAL');
    expect(item.targetPath).toBe('packages/utils/src/sub.ts');
  }, 30_000);

  it('honours every glob in pnpm-workspace.yaml, not just the first', async () => {
    const all = await resolveFixture('ts-monorepo');
    const item = pick(all, 'packages/app/src/main.ts', '@myorg/scripts');
    expect(item.status).toBe('INTERNAL');
    expect(item.targetPath).toBe('tools/scripts/src/index.ts');
  }, 30_000);

  it('keeps real dependencies external in a workspace repo', async () => {
    const all = await resolveFixture('ts-monorepo');
    const item = pick(all, 'packages/app/src/main.ts', 'lodash');
    expect(item.status).toBe('EXTERNAL');
    expect(item.reason).toBe('npm-package');
  }, 30_000);

  it('resolves packages declared via package.json "workspaces"', async () => {
    const all = await resolveFixture('ts-npm-workspaces');
    const FILE = 'packages/web/src/app.ts';

    expect(pick(all, FILE, '@ws/core').status).toBe('INTERNAL');
    expect(pick(all, FILE, '@ws/core').targetPath).toBe('packages/core/src/index.ts');
    expect(pick(all, FILE, 'react').status).toBe('EXTERNAL');
  }, 30_000);
});
