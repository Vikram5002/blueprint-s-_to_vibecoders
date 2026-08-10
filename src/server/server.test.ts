import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { walkRepository } from '../ingest/walk.js';
import { parseRepository, summariseParse } from '../parser/parse-repository.js';
import { summariseWalk } from '../ingest/summary.js';
import { resolveRepository } from '../graph/resolve.js';
import { buildDependencyGraph } from '../graph/build-graph.js';
import { clusterRepository } from '../graph/cluster.js';
import { labelModules } from '../pipeline/label.js';
import { openDatabase, type BlueprintDatabase } from '../store/database.js';
import { createCorrectionsStore } from '../store/corrections-store.js';

const openDatabases: BlueprintDatabase[] = [];
import { encodeEdgeId } from '../graph/aggregate.js';
import { startServer, LOOPBACK_HOST, type RunningServer } from './server.js';
import { detectViolations } from '../conformance/violations.js';
import { summariseSubjects } from '../conformance/resolve-subject.js';
import type { AnalysisContext } from './context.js';

const FIXTURE = fileURLToPath(new URL('../graph/fixtures/ts-monorepo', import.meta.url));

let server: RunningServer;

async function analyse(root: string): Promise<AnalysisContext> {
  const walked = await walkRepository({ root });
  if (!walked.ok) throw new Error(walked.error.message);

  const parsed = await parseRepository({ files: walked.value.files });
  if (!parsed.ok) throw new Error(parsed.error.message);

  const resolution = await resolveRepository({ root, files: parsed.value.files });
  const graph = buildDependencyGraph({ files: parsed.value.files, resolution });
  const clustering = clusterRepository(graph, { minClusterSize: 1 });

  // In-memory store: the server accepts corrections, and the tests exercise
  // that without leaving a database behind.
  const db = openDatabase(':memory:');
  openDatabases.push(db);

  return {
    root,
    graph,
    ingest: summariseWalk(walked.value),
    parse: summariseParse(parsed.value),
    parseFailures: parsed.value.failures,
    clustering,
    labels: await labelModules(clustering),
    correctionOutcomes: clustering.correctionOutcomes,
    /**
     * No key in tests, so both model-dependent stages are empty — which is
     * exactly the shape a real no-key run produces. Supplied explicitly rather
     * than left off: tests are excluded from `tsc`, so a missing context field
     * is not a compile error, it is a runtime failure in whichever route
     * happens to read it first.
     */
    intent: {
      constraints: [],
      uncheckable: [],
      summary: emptyIntentSummary(),
      usage: { promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0, cacheHits: 0, cacheMisses: 0 },
      failures: [],
    },
    conformance: detectViolations({ constraints: [], clustering, fileEdges: [] }),
    store: createCorrectionsStore(db),
    db,
  };
}

function emptyIntentSummary(): AnalysisContext['intent']['summary'] {
  return {
    documents: 0,
    architecturalStatements: 0,
    constraints: 0,
    uncheckable: 0,
    byUncheckableReason: {
      'style-preference': 0,
      'process-rule': 0,
      'runtime-behaviour': 0,
      'unsupported-relation': 0,
      'descriptive-not-normative': 0,
      'technology-choice': 0,
    },
    byRelation: {
      'must-not-import': 0,
      'may-only-import-via': 0,
      'must-not-cycle': 0,
      'must-be-layer-above': 0,
    },
    lowConfidence: 0,
    evaluable: 0,
    subjects: summariseSubjects([]),
    degraded: true,
  };
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${server.url}${path}`);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON response, keep the text */
  }
  return { status: response.status, body };
}

beforeAll(async () => {
  server = await startServer(await analyse(FIXTURE));
}, 60_000);

afterAll(async () => {
  await server?.close();
  for (const db of openDatabases.splice(0)) {
    db.close();
  }
});

describe('binding', () => {
  it('binds loopback on an OS-assigned port', () => {
    expect(server.url).toContain(LOOPBACK_HOST);
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).not.toContain('0.0.0.0');
  });

  it('can be closed and the port released', async () => {
    const second = await startServer(await analyse(FIXTURE));
    expect(second.port).not.toBe(server.port);
    await second.close();
    await expect(fetch(second.url).then(() => 'up')).rejects.toBeDefined();
  }, 60_000);
});

describe('GET /api/summary', () => {
  it('reports counts, resolution rate and unresolved reasons', async () => {
    const { status, body } = await get('/api/summary');
    expect(status).toBe(200);

    const summary = body as Record<string, unknown>;
    expect(summary['files']).toBeGreaterThan(0);
    expect(summary['resolutionRate']).toBeGreaterThan(0);
    expect(summary['imports']).toBeDefined();
    expect(summary['unresolvedByReason']).toBeDefined();
    expect(summary['parse']).toBeDefined();
  });
});

describe('GET /api/graph', () => {
  it('defaults to the directory level with positions for every node', async () => {
    const { body } = await get('/api/graph');
    const graph = body as { level: string; nodes: { id: string }[]; positions: Record<string, unknown> };

    expect(graph.level).toBe('directory');
    expect(graph.nodes.length).toBeGreaterThan(0);
    for (const node of graph.nodes) {
      expect(graph.positions[node.id]).toBeDefined();
    }
  });

  it('collapses files into far fewer nodes than the file level', async () => {
    const directory = (await get('/api/graph')).body as { nodes: unknown[] };
    const file = (await get('/api/graph?level=file')).body as { nodes: unknown[] };

    expect(directory.nodes.length).toBeLessThan(file.nodes.length);
  });

  it('expands a directory on request', async () => {
    const { body } = await get('/api/graph?expand=packages%2Futils%2Fsrc');
    const graph = body as { nodes: { id: string }[]; expanded: string[] };

    expect(graph.expanded).toContain('packages/utils/src');
    expect(graph.nodes.map((n) => n.id)).toContain('packages/utils/src/index.ts');
  });

  it('accepts several expand parameters', async () => {
    const { body } = await get('/api/graph?expand=packages%2Futils%2Fsrc&expand=packages%2Fapp%2Fsrc');
    const graph = body as { expanded: string[] };
    expect(graph.expanded).toHaveLength(2);
  });

  it('carries a violation overlay alongside the edges, never on them', async () => {
    const { body } = await get('/api/graph');
    const graph = body as {
      edges: Record<string, unknown>[];
      violations: { byEdge: Record<string, unknown>; counts: Record<string, number> };
    };

    expect(graph.violations).toBeDefined();
    expect(graph.violations.counts.violations).toBe(0);

    // Rule 2: an edge is DERIVED. A violation is a comparison, and writing it
    // onto the edge would make a claim look like a property of the code.
    for (const edge of graph.edges) {
      expect(edge['severity']).toBeUndefined();
      expect(edge['violation']).toBeUndefined();
      expect(edge['violations']).toBeUndefined();
    }
  });
});

describe('GET /api/violations', () => {
  it('serves the ledger even when there is nothing to report', async () => {
    const { status, body } = await get('/api/violations');
    expect(status).toBe(200);

    const response = body as {
      violations: unknown[];
      summary: { constraints: number; satisfied: number };
      emptyReason: string | null;
      uncheckableStatements: { total: number };
    };
    expect(response.violations).toEqual([]);
    expect(response.summary.constraints).toBe(0);
  });

  /**
   * The distinction Week 8 computes and Week 10 has to make visible. This
   * fixture states no constraints, so the answer must be "nothing was
   * measured" and never "everything passed" — they are opposite findings that
   * both render as a zero.
   */
  it('says zero violations is because zero rules were stated', async () => {
    const { body } = await get('/api/violations');
    expect((body as { emptyReason: string }).emptyReason).toBe('no-constraints');
  });

  it('reports drift as unmeasured rather than perfect when nothing was stated', async () => {
    const { body } = await get('/api/violations');
    const drift = (body as { drift: { score: number; explanation: string } }).drift;
    expect(drift.score).toBe(0);
    expect(drift.explanation).toContain('not measured');
  });
});

describe('GET /api/drift-history', () => {
  it('returns 200 with a reason when no history has been recorded', async () => {
    // Every run starts here — history is opt-in — so an empty history is a
    // normal state of an existing resource, not a missing one. A 404 here put
    // a red error in the browser console on a first visit.
    const { status, body } = await get('/api/drift-history');
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(false);
    expect((body as { reason: string }).reason).toContain('--history');
  });
});

describe('GET /api/snapshot', () => {
  it('404s with a usable reason when no history has been recorded', async () => {
    const { status, body } = await get('/api/snapshot?commit=abc1234');
    expect(status).toBe(404);
    expect((body as { ok: boolean; reason: string }).ok).toBe(false);
    // The message has to name the fix; history is opt-in and expensive.
    expect((body as { reason: string }).reason).toContain('--history');
  });
});

describe('GET /api/node', () => {
  it('returns files, neighbours and externals for a directory', async () => {
    const { status, body } = await get('/api/node/packages/app/src');
    expect(status).toBe(200);

    const node = body as { kind: string; files: string[]; outbound: unknown[]; externals: { name: string }[] };
    expect(node.kind).toBe('directory');
    expect(node.files).toContain('packages/app/src/main.ts');
    expect(node.outbound.length).toBeGreaterThan(0);
    expect(node.externals.map((e) => e.name)).toContain('lodash');
  });

  it('returns detail for a single file', async () => {
    const { body } = await get('/api/node/packages/utils/src/index.ts');
    const node = body as { kind: string; files: string[] };
    expect(node.kind).toBe('file');
    expect(node.files).toEqual(['packages/utils/src/index.ts']);
  });

  it('404s on an unknown node', async () => {
    expect((await get('/api/node/does/not/exist')).status).toBe(404);
  });

  it('reads an empty node path as the repository root', async () => {
    // The root node's id is ".", which browsers strip from a URL path — and
    // Chrome strips "%2E" too, so the client cannot preserve it. The request
    // arrives as /api/node/ and must resolve rather than 404. Clicking the root
    // directory was broken by exactly this until a browser run caught it.
    const response = await fetch(`${server.url}/api/graph`);
    const graph = (await response.json()) as { nodes: { id: string }[] };
    if (!graph.nodes.some((node) => node.id === '.')) {
      return; // this fixture has no files at its root
    }

    const { status, body } = await get('/api/node/');
    expect(status).toBe(200);
    expect((body as { id: string }).id).toBe('.');
  });
});

describe('GET /api/edge — the evidence trail', () => {
  it('returns the real source lines behind an aggregated edge', async () => {
    const id = encodeEdgeId('packages/app/src', 'packages/utils/src');
    const { status, body } = await get(`/api/edge/${id}`);
    expect(status).toBe(200);

    const edge = body as {
      from: string;
      to: string;
      groups: { source: string; target: string; evidence: { file: string; line: number; snippet: string }[] }[];
    };

    expect(edge.from).toBe('packages/app/src');
    expect(edge.to).toBe('packages/utils/src');
    expect(edge.groups.length).toBeGreaterThan(0);

    for (const group of edge.groups) {
      expect(group.evidence.length).toBeGreaterThan(0);
      for (const item of group.evidence) {
        // Every claim must be checkable: a real file, a real line, real text.
        expect(item.file).toBe(group.source);
        expect(item.line).toBeGreaterThan(0);
        expect(item.snippet).toMatch(/import|require/);
      }
    }
  });

  it('quotes the actual import statement, not a paraphrase', async () => {
    const id = encodeEdgeId('packages/app/src', 'packages/utils/src');
    const { body } = await get(`/api/edge/${id}`);
    const edge = body as { groups: { evidence: { snippet: string }[] }[] };

    const snippets = edge.groups.flatMap((group) => group.evidence.map((e) => e.snippet));
    expect(snippets).toContain("import { util } from '@myorg/utils';");
  });

  it('404s on an unknown edge', async () => {
    expect((await get(`/api/edge/${encodeEdgeId('nope', 'nowhere')}`)).status).toBe(404);
  });
});

describe('GET /api/modules', () => {
  it('returns module nodes with positions and DERIVED provenance', async () => {
    const { status, body } = await get('/api/modules');
    expect(status).toBe(200);

    const view = body as {
      nodes: { id: string; provenance: string; llmLabelled: boolean; fileCount: number }[];
      positions: Record<string, unknown>;
      counts: { files: number };
    };

    expect(view.nodes.length).toBeGreaterThan(0);
    for (const node of view.nodes) {
      expect(node.provenance).toBe('DERIVED');
      expect(node.llmLabelled).toBe(false);
      expect(view.positions[node.id]).toBeDefined();
    }

    const totalFiles = view.nodes.reduce((sum, node) => sum + node.fileCount, 0);
    expect(totalFiles).toBe(view.counts.files);
  });

  it('reports clustering diagnostics in the summary', async () => {
    const { body } = await get('/api/summary');
    const summary = body as { clustering: Record<string, unknown> };

    expect(summary.clustering['moduleCount']).toBeGreaterThan(0);
    expect(summary.clustering['modularity']).toBeDefined();
    expect(summary.clustering['seed']).toBeDefined();
    expect(summary.clustering['disagreementRate']).toBeDefined();
  });
});

describe('GET /api/module', () => {
  it('explains why each file is in the module', async () => {
    const view = (await get('/api/modules')).body as { nodes: { id: string }[] };
    const first = view.nodes[0]?.id ?? '';

    const { status, body } = await get(`/api/module/${first}`);
    expect(status).toBe(200);

    const detail = body as {
      files: { path: string; reason: string; explanation: string }[];
    };
    expect(detail.files.length).toBeGreaterThan(0);
    for (const file of detail.files) {
      expect(['import-coupling', 'directory-prior', 'small-cluster-merge']).toContain(file.reason);
      expect(file.explanation.length).toBeGreaterThan(10);
    }
  });

  it('404s on an unknown module', async () => {
    expect((await get('/api/module/module-999')).status).toBe(404);
  });
});

describe('GET /api/module-edge — evidence at module level', () => {
  it('returns the real source lines behind a module-to-module edge', async () => {
    const view = (await get('/api/modules')).body as { edges: { id: string }[] };
    if (view.edges.length === 0) {
      return; // fixture too small to produce inter-module edges
    }

    const { status, body } = await get(`/api/module-edge/${view.edges[0]?.id ?? ''}`);
    expect(status).toBe(200);

    const edge = body as { groups: { source: string; evidence: { file: string; line: number; snippet: string }[] }[] };
    expect(edge.groups.length).toBeGreaterThan(0);

    // Rule 3 has to hold at module level too, not just at file level.
    for (const group of edge.groups) {
      expect(group.evidence.length).toBeGreaterThan(0);
      for (const item of group.evidence) {
        expect(item.file).toBe(group.source);
        expect(item.line).toBeGreaterThan(0);
        expect(item.snippet.length).toBeGreaterThan(0);
      }
    }
  });

  it('404s on an unknown module edge', async () => {
    expect((await get('/api/module-edge/module-999->module-998')).status).toBe(404);
  });
});

describe('static serving', () => {
  it('responds to an unknown path without crashing', async () => {
    const { status } = await get('/some/client/route');
    // 200 when the UI is built, 503 with an explanation when it is not.
    expect([200, 503]).toContain(status);
  });

  it('404s a missing asset instead of returning the HTML shell', async () => {
    // Serving index.html for a missing .js hands the browser HTML where it
    // asked for JavaScript, which shows up as a MIME error rather than a 404.
    const { status } = await get('/assets/does-not-exist.js');
    expect([404, 503]).toContain(status);
  });

  it('refuses to serve files outside the static root', async () => {
    const response = await fetch(`${server.url}/../../package.json`, { redirect: 'manual' });
    const text = await response.text();
    expect(text).not.toContain('"name": "vibe-blueprint"');
  });
});
