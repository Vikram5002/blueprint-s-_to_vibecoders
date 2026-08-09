import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyseRepository } from '../pipeline/analyse.js';
import { correctionId } from './corrections.js';
import type { Correction } from '../types/corrections.js';
import type { ClusteringResult } from '../types/modules.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vibe-corr-'));
  roots.push(root);
  await writeFiles(root, files);
  return root;
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, ...relative.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  }
}

async function cluster(root: string, corrections: readonly Correction[] = []): Promise<ClusteringResult> {
  // Default minClusterSize, so the coupled files coalesce into one module the
  // way they would in a real repository.
  const result = await analyseRepository({ root, cluster: { corrections } });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.clustering;
}

function correction(overrides: Partial<Correction> & Pick<Correction, 'kind' | 'members'>): Correction {
  return {
    id: correctionId(overrides.kind, overrides.members),
    label: null,
    sides: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Five files coupled around a core, plus an unrelated one.
 *
 * Deliberately not tiny: drift is a proportion, so a two-file module cannot
 * lose or gain anything without falling straight through the threshold, and a
 * test built on one would be testing the fixture rather than the rule.
 */
const BASE_REPO: Record<string, string> = {
  'src/a/core.ts': `import { a1 } from './a1';\nimport { a2 } from './a2';\nexport const core = a1 + a2;\n`,
  'src/a/a1.ts': `import { a3 } from './a3';\nexport const a1 = a3;\n`,
  'src/a/a2.ts': `import { a3 } from './a3';\nimport { a4 } from './a4';\nexport const a2 = a3 + a4;\n`,
  'src/a/a3.ts': `import { a4 } from './a4';\nexport const a3 = a4;\n`,
  'src/a/a4.ts': `export const a4 = 1;\n`,
  'src/b/other.ts': `export const other = 2;\n`,
};

/** The module holding the coupled `src/a` files. */
function coupledModule(clustering: ClusteringResult): readonly string[] {
  const module = clustering.modules.find((candidate) => candidate.files.includes('src/a/core.ts'));
  if (module === undefined) throw new Error('no module contains src/a/core.ts');
  return module.files;
}

describe('corrections applied to a real clustering', () => {
  it('renames a module and marks its files as user-corrected', async () => {
    const root = await makeRepo(BASE_REPO);
    const before = await cluster(root);

    const target = coupledModule(before);
    expect(target.length).toBeGreaterThan(1);

    const after = await cluster(root, [
      correction({ kind: 'rename', members: target, label: 'Alpha Subsystem' }),
    ]);

    expect(Object.values(after.correctionLabels)).toContain('Alpha Subsystem');
    expect(after.correctionOutcomes[0]?.status).toBe('applied');

    const moved = after.assignments.filter((a) => a.reason === 'user-correction');
    expect(moved.length).toBeGreaterThan(0);
    expect(moved[0]?.explanation).toContain('by hand');
  }, 60_000);

  it('merges two modules into one', async () => {
    const root = await makeRepo(BASE_REPO);
    const before = await cluster(root);
    expect(before.modules.length).toBeGreaterThan(1);

    const everything = before.modules.flatMap((module) => module.files);
    const after = await cluster(root, [
      correction({ kind: 'merge', members: everything, label: 'Everything' }),
    ]);

    expect(after.modules).toHaveLength(1);
    expect(after.correctionOutcomes[0]?.status).toBe('applied');
    expect(Object.values(after.correctionLabels)).toContain('Everything');
  }, 60_000);

  it('splits a module along explicit file lists', async () => {
    const root = await makeRepo(BASE_REPO);
    const before = await cluster(root);
    const target = before.modules.find((module) => module.files.length > 1);
    expect(target).toBeDefined();

    const [first, ...rest] = target?.files ?? [];
    const after = await cluster(root, [
      correction({
        kind: 'split',
        members: target?.files ?? [],
        sides: [
          { label: 'Left', files: [first ?? ''] },
          { label: 'Right', files: rest },
        ],
      }),
    ]);

    expect(after.modules.length).toBeGreaterThan(before.modules.length);
    expect(Object.values(after.correctionLabels)).toEqual(
      expect.arrayContaining(['Left', 'Right']),
    );
  }, 60_000);

  it('keeps module ids content-derived after a correction', async () => {
    const root = await makeRepo(BASE_REPO);
    const before = await cluster(root);
    const after = await cluster(root, [
      correction({ kind: 'merge', members: before.modules.flatMap((m) => m.files), label: 'One' }),
    ]);

    for (const module of after.modules) {
      expect(module.id).toMatch(/^module-\d{3}$/);
    }
  }, 60_000);
});

describe('surviving a real repository change', () => {
  it('reports drift and names the files that joined and left', async () => {
    const root = await makeRepo(BASE_REPO);
    const files = coupledModule(await cluster(root));
    expect(files.length).toBeGreaterThanOrEqual(5);

    // A correction made when the module held all but the last file, and also
    // held one that has since been deleted. Four shared of six combined = 0.67,
    // above the threshold, so it applies — and says what moved.
    const stored = correction({
      kind: 'rename',
      members: [...files.slice(0, -1), 'src/a/deleted.ts'],
      label: 'Alpha',
    });

    const after = await cluster(root, [stored]);
    const outcome = after.correctionOutcomes[0];

    expect(outcome?.status).toBe('applied-with-drift');
    expect(outcome?.joined).toEqual([files[files.length - 1]]);
    expect(outcome?.left).toEqual(['src/a/deleted.ts']);
    expect(outcome?.explanation).toContain('joined');
    // Applied despite the drift — the rename is not lost.
    expect(Object.values(after.correctionLabels)).toContain('Alpha');
  }, 60_000);

  it('orphans a correction whose module has been rewritten', async () => {
    const root = await makeRepo(BASE_REPO);

    const stored = correction({
      kind: 'rename',
      members: ['src/gone/a.ts', 'src/gone/b.ts', 'src/gone/c.ts', 'src/gone/d.ts'],
      label: 'Ghost Module',
    });

    const after = await cluster(root, [stored]);
    const outcome = after.correctionOutcomes[0];

    expect(outcome?.status).toBe('orphaned');
    expect(outcome?.moduleId).toBeNull();
    expect(Object.values(after.correctionLabels)).not.toContain('Ghost Module');
    expect(outcome?.explanation).toContain('Not reapplied');
  }, 60_000);

  it('reports a file that belongs to neither side of a split', async () => {
    const root = await makeRepo(BASE_REPO);
    const files = coupledModule(await cluster(root));

    // The split was made before the last file existed, so no side claims it.
    const claimed = files.slice(0, -1);
    const orphanFile = files[files.length - 1] ?? '';
    const stored = correction({
      kind: 'split',
      members: files,
      sides: [
        { label: 'Left', files: claimed.slice(0, 2) },
        { label: 'Right', files: claimed.slice(2) },
      ],
    });

    const after = await cluster(root, [stored]);
    const outcome = after.correctionOutcomes[0];

    expect(outcome?.unresolved).toEqual([orphanFile]);
    expect(outcome?.explanation).toContain('neither side');

    // Not guessed into a side: it is in neither Left nor Right.
    const leftId = Object.entries(after.correctionLabels).find(([, l]) => l === 'Left')?.[0];
    const rightId = Object.entries(after.correctionLabels).find(([, l]) => l === 'Right')?.[0];
    const home = after.assignments.find((a) => a.file === orphanFile)?.moduleId;
    expect(home).not.toBe(leftId);
    expect(home).not.toBe(rightId);
  }, 60_000);
});

describe('determinism with corrections', () => {
  it('produces byte-identical clustering across repeated runs', async () => {
    const root = await makeRepo(BASE_REPO);
    const before = await cluster(root);
    const corrections = [
      correction({ kind: 'rename', members: before.modules[0]?.files ?? [], label: 'One' }),
      correction({ kind: 'rename', members: before.modules[1]?.files ?? [], label: 'Two' }),
    ];

    const first = JSON.stringify(await cluster(root, corrections));
    for (let run = 0; run < 3; run += 1) {
      expect(JSON.stringify(await cluster(root, corrections))).toBe(first);
    }
  }, 120_000);

  it('does not depend on the order corrections are supplied in', async () => {
    const root = await makeRepo(BASE_REPO);
    const before = await cluster(root);
    const a = correction({ kind: 'rename', members: before.modules[0]?.files ?? [], label: 'A' });
    const b = correction({ kind: 'rename', members: before.modules[1]?.files ?? [], label: 'B' });

    expect(JSON.stringify(await cluster(root, [a, b]))).toBe(JSON.stringify(await cluster(root, [b, a])));
  }, 120_000);

  it('changes nothing when there are no corrections', async () => {
    const root = await makeRepo(BASE_REPO);
    const plain = await cluster(root);

    expect(plain.correctionOutcomes).toEqual([]);
    expect(plain.correctionLabels).toEqual({});
    expect(plain.assignments.every((a) => a.reason !== 'user-correction')).toBe(true);
  }, 60_000);
});
