import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { walkRepository } from '../ingest/walk.js';
import { parseRepository } from '../parser/parse-repository.js';
import { resolveRepository } from './resolve.js';
import { isStandardLibraryModule } from './python-stdlib.js';
import type { ResolvedImport } from '../types/resolution.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

async function resolveFixture(name: string): Promise<ResolvedImport[]> {
  const root = `${FIXTURES}${name}`;

  const walked = await walkRepository({ root });
  if (!walked.ok) throw new Error(walked.error.message);

  const parsed = await parseRepository({ files: walked.value.files });
  if (!parsed.ok) throw new Error(parsed.error.message);

  const resolved = await resolveRepository({ root, files: parsed.value.files });
  return [...resolved.imports];
}

function pick(all: readonly ResolvedImport[], file: string, specifier: string, level = 0): ResolvedImport {
  const found = all.find(
    (item) =>
      item.record.evidence.file === file &&
      item.record.specifier === specifier &&
      item.record.relativeLevel === level,
  );
  if (found === undefined) {
    const seen = all
      .filter((i) => i.record.evidence.file === file)
      .map((i) => `${'.'.repeat(i.record.relativeLevel)}${i.record.specifier}`)
      .join(', ');
    throw new Error(`no import "${'.'.repeat(level)}${specifier}" in ${file}; saw: ${seen}`);
  }
  return found;
}

describe('py-package: __init__.py packages', () => {
  it('resolves an absolute intra-package import', async () => {
    const all = await resolveFixture('py-package');
    const item = pick(all, 'myapp/main.py', 'myapp.helpers');

    expect(item.status).toBe('INTERNAL');
    expect(item.targetPath).toBe('myapp/helpers.py');
  }, 30_000);

  it('resolves a dotted submodule', async () => {
    const all = await resolveFixture('py-package');
    expect(pick(all, 'myapp/main.py', 'myapp.sub.deep').targetPath).toBe('myapp/sub/deep.py');
  }, 30_000);

  it('resolves `from . import helpers` to the sibling module', async () => {
    const all = await resolveFixture('py-package');
    const item = pick(all, 'myapp/main.py', '', 1);

    expect(item.status).toBe('INTERNAL');
    expect(item.targetPath).toBe('myapp/helpers.py');
  }, 30_000);

  it('resolves `from .helpers import x` at level 1', async () => {
    const all = await resolveFixture('py-package');
    expect(pick(all, 'myapp/main.py', 'helpers', 1).targetPath).toBe('myapp/helpers.py');
  }, 30_000);

  it('resolves a relative dotted subpackage', async () => {
    const all = await resolveFixture('py-package');
    expect(pick(all, 'myapp/main.py', 'sub.deep', 1).targetPath).toBe('myapp/sub/deep.py');
  }, 30_000);

  it('resolves `from .sub import deep` where the name is the module', async () => {
    const all = await resolveFixture('py-package');
    expect(pick(all, 'myapp/main.py', 'sub', 1).targetPath).toBe('myapp/sub/deep.py');
  }, 30_000);

  it('reports a relative import that climbs past the root, with a reason', async () => {
    const all = await resolveFixture('py-package');
    const item = pick(all, 'myapp/main.py', 'outside', 2);

    expect(item.status).toBe('UNRESOLVED');
    expect(item.reason).toBe('relative-beyond-root');
  }, 30_000);

  it('resolves imports from a sibling top-level directory', async () => {
    const all = await resolveFixture('py-package');
    expect(pick(all, 'tests/test_main.py', 'myapp.main').targetPath).toBe('myapp/main.py');
  }, 30_000);

  it('points `from pkg import submodule` at the submodule, not the package init', async () => {
    // The dependency is on myapp/helpers.py; myapp/__init__.py is only the route
    // to it. Same rule as `from .sub import deep` resolving to sub/deep.py.
    const all = await resolveFixture('py-package');
    expect(pick(all, 'tests/test_main.py', 'myapp').targetPath).toBe('myapp/helpers.py');
  }, 30_000);

  it('finds imports inside try/except and marks the third-party one external', async () => {
    const all = await resolveFixture('py-package');
    expect(pick(all, 'myapp/main.py', 'ujson').status).toBe('EXTERNAL');
    expect(pick(all, 'myapp/main.py', 'json').reason).toBe('python-stdlib');
  }, 30_000);
});

describe('py-namespace: PEP 420 packages without __init__.py', () => {
  it('resolves an absolute import with no __init__.py anywhere', async () => {
    const all = await resolveFixture('py-namespace');
    const item = pick(all, 'nspkg/mod_b.py', 'nspkg.mod_a');

    expect(item.status).toBe('INTERNAL');
    expect(item.targetPath).toBe('nspkg/mod_a.py');
  }, 30_000);

  it('resolves a relative import in a namespace package', async () => {
    const all = await resolveFixture('py-namespace');
    expect(pick(all, 'nspkg/mod_b.py', '', 1).targetPath).toBe('nspkg/mod_a.py');
  }, 30_000);

  it('resolves a nested namespace subpackage', async () => {
    const all = await resolveFixture('py-namespace');
    expect(pick(all, 'nspkg/mod_b.py', 'inner.leaf', 1).targetPath).toBe('nspkg/inner/leaf.py');
    expect(pick(all, 'nspkg/mod_b.py', 'nspkg.inner.leaf').targetPath).toBe('nspkg/inner/leaf.py');
  }, 30_000);
});

describe('py-src-layout: package root below the repo root', () => {
  it('resolves an absolute import rooted at src/', async () => {
    const all = await resolveFixture('py-src-layout');
    const item = pick(all, 'src/proj/app.py', 'proj.core');

    expect(item.status).toBe('INTERNAL');
    expect(item.targetPath).toBe('src/proj/core.py');
  }, 30_000);

  it('resolves the relative form of the same import', async () => {
    const all = await resolveFixture('py-src-layout');
    expect(pick(all, 'src/proj/app.py', 'core', 1).targetPath).toBe('src/proj/core.py');
  }, 30_000);
});

describe('py-external: stdlib and third-party', () => {
  it.each(['os', 'sys', 'json', 'asyncio', 'dataclasses', 'pathlib'])(
    'classifies %s as stdlib',
    async (name) => {
      const all = await resolveFixture('py-external');
      const item = pick(all, 'app.py', name);
      expect(item.status).toBe('EXTERNAL');
      expect(item.reason).toBe('python-stdlib');
    },
    30_000,
  );

  it('classifies dotted stdlib submodules by their top-level package', async () => {
    const all = await resolveFixture('py-external');
    expect(pick(all, 'app.py', 'collections.abc').reason).toBe('python-stdlib');
    expect(pick(all, 'app.py', 'xml.etree.ElementTree').reason).toBe('python-stdlib');
    expect(pick(all, 'app.py', 'concurrent.futures').reason).toBe('python-stdlib');
  }, 30_000);

  it.each(['numpy', 'requests', 'django.db.models', 'flask', 'totally_made_up_package'])(
    'classifies %s as site-packages',
    async (name) => {
      const all = await resolveFixture('py-external');
      const item = pick(all, 'app.py', name);
      expect(item.status).toBe('EXTERNAL');
      expect(item.reason).toBe('python-site-packages');
    },
    30_000,
  );

  it('never leaves a plain third-party import unresolved', async () => {
    const all = await resolveFixture('py-external');
    expect(all.filter((item) => item.status === 'UNRESOLVED')).toEqual([]);
  }, 30_000);
});

describe('isStandardLibraryModule', () => {
  it('matches on the top-level package only', () => {
    expect(isStandardLibraryModule('os')).toBe(true);
    expect(isStandardLibraryModule('os.path')).toBe(true);
    expect(isStandardLibraryModule('xml.etree.ElementTree')).toBe(true);
  });

  it('does not match third-party names', () => {
    expect(isStandardLibraryModule('numpy')).toBe(false);
    expect(isStandardLibraryModule('requests')).toBe(false);
    expect(isStandardLibraryModule('osmium')).toBe(false);
  });

  it('handles an empty specifier', () => {
    expect(isStandardLibraryModule('')).toBe(false);
  });
});
