import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { walkRepository } from '../ingest/walk.js';
import { parseRepository, summariseParse } from '../parser/parse-repository.js';
import { summariseWalk } from '../ingest/summary.js';
import { resolveRepository } from '../graph/resolve.js';
import { buildDependencyGraph } from '../graph/build-graph.js';
import { encodeEdgeId } from '../graph/aggregate.js';
import { startServer, LOOPBACK_HOST, type RunningServer } from './server.js';
import type { AnalysisContext } from './context.js';

const FIXTURE = fileURLToPath(new URL('../graph/fixtures/ts-monorepo', import.meta.url));

let server: RunningServer;

async function analyse(root: string): Promise<AnalysisContext> {
  const walked = await walkRepository({ root });
  if (!walked.ok) throw new Error(walked.error.message);

  const parsed = await parseRepository({ files: walked.value.files });
  if (!parsed.ok) throw new Error(parsed.error.message);

  const resolution = await resolveRepository({ root, files: parsed.value.files });
  return {
    root,
    graph: buildDependencyGraph({ files: parsed.value.files, resolution }),
    ingest: summariseWalk(walked.value),
    parse: summariseParse(parsed.value),
    parseFailures: parsed.value.failures,
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
