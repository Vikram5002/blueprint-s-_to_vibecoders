import { describe, expect, it } from 'vitest';
import { diffSnapshots, RENAME_OVERLAP_THRESHOLD } from './diff.js';
import { buildSnapshot, computeDrift } from '../store/snapshots.js';
import type { Snapshot, SnapshotModule } from '../types/snapshots.js';
import type { ConformanceResult } from '../types/violations.js';

function snapshot(overrides: Partial<Snapshot>): Snapshot {
  const base: Snapshot = {
    id: 'snap',
    commit: 'a'.repeat(40),
    committedAt: '2026-01-01T00:00:00Z',
    subject: 'a commit',
    fileCount: 0,
    edgeCount: 0,
    moduleCount: 0,
    violationCount: 0,
    modules: [],
    edges: [],
    constraints: [],
    violations: [],
    activeCorrections: [],
    drift: {
      score: 0,
      weightedViolations: 0,
      totalConstraints: 0,
      checkedConstraints: 0,
      bySeverity: { high: 0, medium: 0, low: 0 },
      explanation: 'none',
    },
  };
  return { ...base, ...overrides };
}

const mod = (id: string, label: string, files: string[]): SnapshotModule => ({ id, label, files });

describe('modules', () => {
  it('says nothing when nothing changed', () => {
    const modules = [mod('m1', 'Parser', ['a.ts', 'b.ts'])];
    const diff = diffSnapshots(snapshot({ modules }), snapshot({ modules }));
    expect(diff.entries).toEqual([]);
  });

  it('reports a new module', () => {
    const diff = diffSnapshots(
      snapshot({ modules: [] }),
      snapshot({ modules: [mod('m1', 'Parser', ['a.ts'])] }),
    );
    expect(diff.entries[0]?.kind).toBe('module-added');
    expect(diff.entries[0]?.description).toContain('Parser');
  });

  /**
   * The case the whole threshold exists for. Cluster ids are content-derived,
   * so adding one file changes the id — without an overlap test this would read
   * as a delete plus a create on every commit that touches a module.
   */
  it('treats a high-overlap id change as a rename, not a delete and create', () => {
    const before = [mod('old-id', 'Parser', ['a.ts', 'b.ts', 'c.ts', 'd.ts'])];
    const after = [mod('new-id', 'Parser', ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'])];

    const diff = diffSnapshots(snapshot({ modules: before }), snapshot({ modules: after }));
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]?.kind).toBe('module-renamed');
    expect(diff.summary.byKind['module-removed']).toBe(0);
    expect(diff.summary.byKind['module-added']).toBe(0);
  });

  it('names the files that joined and left a renamed module', () => {
    const before = [mod('old', 'Parser', ['a.ts', 'b.ts', 'c.ts', 'd.ts'])];
    const after = [mod('new', 'Parser', ['a.ts', 'b.ts', 'c.ts', 'e.ts'])];

    const entry = diffSnapshots(snapshot({ modules: before }), snapshot({ modules: after })).entries[0];
    expect(entry?.evidence).toContain('+ e.ts');
    expect(entry?.evidence).toContain('- d.ts');
  });

  it('reports a pure relabel with no membership change', () => {
    const files = ['a.ts', 'b.ts'];
    const diff = diffSnapshots(
      snapshot({ modules: [mod('m1', 'Old Name', files)] }),
      snapshot({ modules: [mod('m1', 'New Name', files)] }),
    );
    expect(diff.entries[0]?.kind).toBe('module-renamed');
    expect(diff.entries[0]?.description).toContain('did not change');
  });

  it('calls a low-overlap change a restructure, not a rename', () => {
    // 1 shared file of 7 = 0.14 overlap, well under the threshold.
    const before = [mod('old', 'Monolith', ['a.ts', 'b.ts', 'c.ts', 'd.ts'])];
    const after = [mod('new', 'Something Else', ['a.ts', 'x.ts', 'y.ts', 'z.ts'])];

    const diff = diffSnapshots(snapshot({ modules: before }), snapshot({ modules: after }));
    const kinds = diff.entries.map((entry) => entry.kind);
    expect(kinds).toContain('module-restructured');
    expect(kinds).toContain('module-added');
    expect(kinds).not.toContain('module-renamed');
  });

  it('explains a restructure in terms of the threshold it missed', () => {
    const before = [mod('old', 'Monolith', ['a.ts', 'b.ts', 'c.ts', 'd.ts'])];
    const after = [mod('new', 'Other', ['a.ts', 'x.ts', 'y.ts', 'z.ts'])];
    const entry = diffSnapshots(snapshot({ modules: before }), snapshot({ modules: after })).entries.find(
      (candidate) => candidate.kind === 'module-restructured',
    );
    expect(entry?.description).toContain(`${RENAME_OVERLAP_THRESHOLD * 100}%`);
  });

  it('reports a module that vanished entirely as removed', () => {
    const diff = diffSnapshots(
      snapshot({ modules: [mod('m1', 'Gone', ['a.ts'])] }),
      snapshot({ modules: [mod('m2', 'Other', ['z.ts'])] }),
    );
    const kinds = diff.entries.map((entry) => entry.kind);
    expect(kinds).toContain('module-removed');
  });

  it('does not pair one module with two', () => {
    const before = [mod('old', 'Big', ['a.ts', 'b.ts', 'c.ts', 'd.ts'])];
    const after = [
      mod('n1', 'Half One', ['a.ts', 'b.ts', 'c.ts', 'd.ts']),
      mod('n2', 'Half Two', ['a.ts', 'b.ts', 'c.ts', 'd.ts']),
    ];
    const diff = diffSnapshots(snapshot({ modules: before }), snapshot({ modules: after }));
    expect(diff.summary.byKind['module-renamed']).toBe(1);
    expect(diff.summary.byKind['module-added']).toBe(1);
  });
});

describe('edges', () => {
  const edge = (id: string, from: string, to: string, importCount = 1) => ({ id, from, to, importCount });

  it('reports an added edge in plain language', () => {
    const diff = diffSnapshots(
      snapshot({ edges: [] }),
      snapshot({ edges: [edge('e1', 'src/auth/a.ts', 'src/billing/b.ts')] }),
    );
    expect(diff.entries[0]?.kind).toBe('edge-added');
    expect(diff.entries[0]?.description).toBe('src/auth/a.ts now imports src/billing/b.ts.');
  });

  it('reports a removed edge', () => {
    const diff = diffSnapshots(
      snapshot({ edges: [edge('e1', 'a.ts', 'b.ts')] }),
      snapshot({ edges: [] }),
    );
    expect(diff.entries[0]?.kind).toBe('edge-removed');
  });

  it('reports a weight change with both numbers', () => {
    const diff = diffSnapshots(
      snapshot({ edges: [edge('e1', 'a.ts', 'b.ts', 2)] }),
      snapshot({ edges: [edge('e1', 'a.ts', 'b.ts', 5)] }),
    );
    expect(diff.entries[0]?.kind).toBe('edge-weight-changed');
    expect(diff.entries[0]?.evidence).toContain('2 -> 5');
  });

  it('says nothing about an unchanged edge', () => {
    const edges = [edge('e1', 'a.ts', 'b.ts', 3)];
    expect(diffSnapshots(snapshot({ edges }), snapshot({ edges })).entries).toEqual([]);
  });
});

describe('constraints', () => {
  const constraint = (id: string, rawText: string) => ({
    id,
    relation: 'must-not-import',
    subject: 'the api',
    object: 'the database',
    rawText,
    source: 'AGENTS.md:4',
    confidence: 1,
  });

  it('reports a rule that appeared, quoting it', () => {
    const diff = diffSnapshots(
      snapshot({ constraints: [] }),
      snapshot({ constraints: [constraint('c1', 'The api must not import the database.')] }),
    );
    expect(diff.entries[0]?.kind).toBe('constraint-added');
    expect(diff.entries[0]?.evidence).toContain('"The api must not import the database."');
    expect(diff.entries[0]?.evidence).toContain('AGENTS.md:4');
  });

  it('reports a rule that disappeared, without guessing why', () => {
    const diff = diffSnapshots(
      snapshot({ constraints: [constraint('c1', 'The api must not import the database.')] }),
      snapshot({ constraints: [] }),
    );
    expect(diff.entries[0]?.kind).toBe('constraint-removed');
    // Dropped, reworded or moved are indistinguishable from here, and the
    // description says so rather than picking one.
    expect(diff.entries[0]?.description).toContain('dropped, reworded');
  });
});

describe('violations', () => {
  const violation = (id: string, severity: 'high' | 'medium' | 'low') => ({
    id,
    constraintId: 'c1',
    kind: 'forbidden-import',
    severity,
    explanation: 'the api imports the database',
    edgeIds: ['e1'],
  });

  it('reports a violation appearing, with its drift weight', () => {
    const diff = diffSnapshots(
      snapshot({ violations: [] }),
      snapshot({ violations: [violation('v1', 'high')] }),
    );
    expect(diff.entries[0]?.kind).toBe('violation-appeared');
    expect(diff.entries[0]?.drift).toEqual({ weightBefore: 0, weightAfter: 3 });
  });

  it('reports a violation resolving, which is the good news case', () => {
    const diff = diffSnapshots(
      snapshot({ violations: [violation('v1', 'medium')] }),
      snapshot({ violations: [] }),
    );
    expect(diff.entries[0]?.kind).toBe('violation-resolved');
    expect(diff.entries[0]?.drift).toEqual({ weightBefore: 2, weightAfter: 0 });
  });
});

describe('comparability', () => {
  it('flags a diff whose snapshots ran under different corrections', () => {
    const diff = diffSnapshots(
      snapshot({ activeCorrections: [] }),
      snapshot({ activeCorrections: ['corr-1'] }),
    );
    expect(diff.summary.comparable).toBe(false);
    expect(diff.summary.comparabilityNote).toContain('not changes the code underwent');
  });

  it('confirms comparability when the corrections match', () => {
    const diff = diffSnapshots(
      snapshot({ activeCorrections: ['corr-1'] }),
      snapshot({ activeCorrections: ['corr-1'] }),
    );
    expect(diff.summary.comparable).toBe(true);
  });
});

describe('determinism', () => {
  const before = snapshot({
    modules: [mod('m1', 'A', ['a.ts']), mod('m2', 'B', ['b.ts'])],
    edges: [{ id: 'e1', from: 'a.ts', to: 'b.ts', importCount: 1 }],
  });
  const after = snapshot({
    modules: [mod('m2', 'B', ['b.ts']), mod('m3', 'C', ['c.ts'])],
    edges: [{ id: 'e2', from: 'b.ts', to: 'c.ts', importCount: 2 }],
  });

  it('produces byte-identical output across runs', () => {
    expect(JSON.stringify(diffSnapshots(before, after))).toBe(JSON.stringify(diffSnapshots(before, after)));
  });

  it('does not depend on the order modules or edges are listed in', () => {
    const shuffled = snapshot({
      modules: [...after.modules].reverse(),
      edges: [...after.edges].reverse(),
    });
    expect(JSON.stringify(diffSnapshots(before, after))).toBe(JSON.stringify(diffSnapshots(before, shuffled)));
  });
});

describe('drift score', () => {
  const conformance = (
    violations: { severity: 'high' | 'medium' | 'low' }[],
    constraints: number,
    checked = constraints,
  ): ConformanceResult =>
    ({
      violations: violations.map((v, i) => ({ ...v, id: `v${i}` })),
      unchecked: [],
      summary: { constraints, checked, violations: violations.length },
    }) as unknown as ConformanceResult;

  it('follows the formula in ARCHITECTURE.md', () => {
    // (3 + 2 + 1) / 4 * 100 = 150
    const drift = computeDrift(conformance([{ severity: 'high' }, { severity: 'medium' }, { severity: 'low' }], 4));
    expect(drift.weightedViolations).toBe(6);
    expect(drift.score).toBe(150);
  });

  it('is zero when every rule holds', () => {
    expect(computeDrift(conformance([], 3)).score).toBe(0);
  });

  it('divides by total constraints, not by the ones that could be checked', () => {
    // Unevaluable rules must not flatter the score.
    const drift = computeDrift(conformance([{ severity: 'high' }], 4, 1));
    expect(drift.score).toBe(75);
    expect(drift.checkedConstraints).toBe(1);
  });

  it('distinguishes "nothing stated" from "nothing broken"', () => {
    const nothing = computeDrift(conformance([], 0));
    expect(nothing.score).toBe(0);
    expect(nothing.explanation).toContain('not measured');
  });

  it('explains itself arithmetically', () => {
    const drift = computeDrift(conformance([{ severity: 'high' }, { severity: 'high' }], 2));
    expect(drift.explanation).toContain('2x3');
    expect(drift.explanation).toContain('2 stated constraint(s)');
  });
});

describe('snapshot identity', () => {
  const options = {
    commit: 'c'.repeat(40),
    committedAt: '2026-01-01T00:00:00Z',
    subject: 'test',
    clustering: { modules: [{ id: 'm1', label: 'A', files: ['b.ts', 'a.ts'] }] },
    labels: { labels: new Map() },
    fileEdges: [{ id: 'e1', from: 'a.ts', to: 'b.ts', importCount: 1, evidence: [], provenance: 'DERIVED' }],
    constraints: [],
    conformance: { violations: [], unchecked: [], summary: { constraints: 0, checked: 0, violations: 0 } },
    activeCorrections: ['z', 'a'],
    fileCount: 2,
  } as unknown as Parameters<typeof buildSnapshot>[0];

  it('is content-derived and stable', () => {
    expect(buildSnapshot(options).id).toBe(buildSnapshot(options).id);
  });

  it('sorts membership and corrections, so input order cannot change the id', () => {
    const snap = buildSnapshot(options);
    expect(snap.modules[0]?.files).toEqual(['a.ts', 'b.ts']);
    expect(snap.activeCorrections).toEqual(['a', 'z']);
  });

  it('carries no wall-clock time — only the commit\'s own date', () => {
    const snap = buildSnapshot(options);
    expect(snap.committedAt).toBe('2026-01-01T00:00:00Z');
    expect(JSON.stringify(snap)).not.toContain(new Date().getFullYear().toString() + '-' + String(new Date().getMonth() + 1).padStart(2, '0') + '-' + String(new Date().getDate()).padStart(2, '0') + 'T');
  });
});
