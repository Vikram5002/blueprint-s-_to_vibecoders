import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { handleMessage, serveMcp } from './server.js';
import { TOOL_DEFINITIONS } from './tools.js';
import {
  ERROR_INVALID_REQUEST,
  ERROR_METHOD_NOT_FOUND,
  ERROR_PARSE,
  isFailure,
  negotiateVersion,
  parseMessage,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcRequest,
} from './protocol.js';
import type { AnalysisContext } from '../server/context.js';

// ---------------------------------------------------------------- fixture

/**
 * A repository with one stated rule that its own code breaks: the parser
 * imports the model adapter. Small, but it exercises every tool with a real
 * answer rather than an empty one.
 */
function context(): AnalysisContext {
  const constraint = {
    id: 'c-1',
    relation: 'must-not-import' as const,
    subject: {
      phrase: 'the parser',
      status: 'MODULE' as const,
      target: 'm-parser',
      reason: null,
      similarity: 1,
      alternatives: [],
    },
    object: {
      phrase: 'the model adapter',
      status: 'MODULE' as const,
      target: 'm-llm',
      reason: null,
      similarity: 1,
      alternatives: [],
    },
    via: null,
    source: { type: 'agents-md' as const, location: 'CLAUDE.md', line: 7, timestamp: null },
    confidence: 0.9,
    lowConfidence: false,
    rawText: 'parser/ must NEVER import from llm/.',
    provenance: 'STATED' as const,
  };

  const evidence = [{ file: 'src/parser/parse.ts', line: 2, snippet: "import x from '../llm/a.js';" }];

  return {
    root: '/repo',
    graph: {
      graph: {
        order: 2,
        size: 1,
        mapEdges: (fn: (key: string, attributes: unknown, source: string, target: string) => unknown) => [
          fn('e0', { count: 1, evidence, provenance: 'DERIVED' }, 'src/parser/parse.ts', 'src/llm/a.ts'),
        ],
      },
      unresolved: [],
    },
    clustering: {
      modules: [
        { id: 'm-parser', label: 'm-parser', files: ['src/parser/parse.ts'], directories: ['src/parser'] },
        { id: 'm-llm', label: 'm-llm', files: ['src/llm/a.ts'], directories: ['src/llm'] },
      ],
      edges: [],
      assignments: [
        { file: 'src/parser/parse.ts', moduleId: 'm-parser', directory: 'src/parser' },
        { file: 'src/llm/a.ts', moduleId: 'm-llm', directory: 'src/llm' },
      ],
      summary: { moduleCount: 2 },
    },
    labels: { labels: new Map(), summary: {} },
    intent: {
      constraints: [constraint],
      uncheckable: [],
      failures: [],
      summary: {
        documents: 1,
        uncheckable: 61,
        byUncheckableReason: { 'style-preference': 61 },
        incompleteDocuments: 0,
        degraded: false,
      },
    },
    conformance: {
      violations: [
        {
          id: 'v-1',
          constraintId: 'c-1',
          kind: 'forbidden-import',
          severity: 'high',
          severityScore: 0.81,
          severityFactors: ['confidence 0.9'],
          explanation: 'the parser imports the model adapter.',
          cycle: [],
          edges: [
            {
              edgeId: 'src/parser/parse.ts|src/llm/a.ts',
              fromFile: 'src/parser/parse.ts',
              toFile: 'src/llm/a.ts',
              fromModule: 'm-parser',
              toModule: 'm-llm',
              importCount: 1,
              evidence,
            },
          ],
          constraint,
        },
      ],
      unchecked: [],
      summary: {
        constraints: 1,
        checked: 1,
        satisfied: 0,
        unchecked: 0,
        violated: 1,
        violations: 1,
        bySeverity: { high: 1, medium: 0, low: 0 },
        byKind: {},
        byUncheckedReason: {},
        implicatedEdges: 1,
      },
    },
  } as unknown as AnalysisContext;
}

function request(method: string, params?: unknown, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

/**
 * Successful tools return JSON; error outcomes return a plain sentence, since
 * that is what a model actually reads. The helper tolerates both rather than
 * assuming every payload parses.
 */
function call(name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  const response = handleMessage(context(), request('tools/call', { name, arguments: args }));
  const result = (response as { result: { content: { text: string }[]; isError: boolean } }).result;
  const text = result.content[0]?.text ?? '';

  try {
    return { ...(JSON.parse(text) as Record<string, unknown>), isError: result.isError };
  } catch {
    return { message: text, isError: result.isError };
  }
}

// ---------------------------------------------------------------- handshake

describe('the handshake', () => {
  it('answers initialize with a version, capabilities and a name', () => {
    const response = handleMessage(context(), request('initialize', { protocolVersion: '2025-06-18' }));
    const result = (response as { result: Record<string, unknown> }).result;

    expect(result['protocolVersion']).toBe('2025-06-18');
    expect(result['serverInfo']).toEqual({ name: 'vibe-blueprint', version: '0.1.0' });
    expect(result['capabilities']).toEqual({ tools: {} });
  });

  it('declares no capability that implies writing', () => {
    // Read-only is a promise made at discovery time. If this ever grows a
    // `resources` or `prompts` entry it should be a deliberate decision with a
    // failing test in front of it.
    const response = handleMessage(context(), request('initialize', {}));
    const capabilities = (response as { result: { capabilities: Record<string, unknown> } }).result
      .capabilities;
    expect(Object.keys(capabilities)).toEqual(['tools']);
  });

  it('echoes a version it knows and falls back to its newest otherwise', () => {
    expect(negotiateVersion('2024-11-05')).toBe('2024-11-05');
    expect(negotiateVersion('1999-01-01')).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(negotiateVersion(undefined)).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  it('never answers a notification', () => {
    // JSON-RPC 2.0 §4.1. Replying to notifications/initialized makes stricter
    // clients report a protocol error, and it is the easiest thing to get
    // wrong in a hand-rolled server.
    const notification: JsonRpcRequest = { jsonrpc: '2.0', method: 'notifications/initialized' };
    expect(handleMessage(context(), notification)).toBeNull();
  });

  it('answers ping', () => {
    expect((handleMessage(context(), request('ping')) as { result: unknown }).result).toEqual({});
  });

  it('reports an unknown method as method-not-found rather than crashing', () => {
    const response = handleMessage(context(), request('resources/list'));
    expect((response as { error: { code: number } }).error.code).toBe(ERROR_METHOD_NOT_FOUND);
  });
});

describe('framing', () => {
  it('turns a malformed line into a parse error instead of throwing', () => {
    const parsed = parseMessage('{not json');
    expect(isFailure(parsed) && parsed.error.code).toBe(ERROR_PARSE);
  });

  it('rejects a message that is not JSON-RPC 2.0', () => {
    const parsed = parseMessage(JSON.stringify({ jsonrpc: '1.0', method: 'x', id: 1 }));
    expect(isFailure(parsed) && parsed.error.code).toBe(ERROR_INVALID_REQUEST);
  });

  it('reads and writes one message per line over a real stream', async () => {
    const input = new PassThrough();
    const written: string[] = [];

    const done = serveMcp(context(), { input, write: (line) => written.push(line) });
    input.write(`${JSON.stringify(request('initialize', {}, 1))}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify(request('tools/list', undefined, 2))}\n`);
    input.end();
    await done;

    // Two requests, one notification, and therefore exactly two replies.
    expect(written).toHaveLength(2);
    expect(written.every((line) => !line.includes('\n'))).toBe(true);
    expect(JSON.parse(written[1] as string).id).toBe(2);
  });
});

// ---------------------------------------------------------------- tools

describe('tools/list', () => {
  it('offers the four read-only tools', () => {
    const response = handleMessage(context(), request('tools/list'));
    const tools = (response as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'check_import',
      'get_architecture',
      'get_constraints',
      'get_violations',
    ]);
  });

  it('gives every tool a schema a client can validate against', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.inputSchema['type']).toBe('object');
      expect(tool.description.length).toBeGreaterThan(80);
    }
  });
});

describe('check_import over the wire', () => {
  it('forbids the import the repository forbids', () => {
    const result = call('check_import', { from: 'src/parser/parse.ts', to: 'src/llm/a.ts' }) as {
      verdict: string;
      explanation: string;
    };
    expect(result.verdict).toBe('forbidden');
    expect(result.explanation).toContain('CLAUDE.md:7');
  });

  it('allows the reverse direction', () => {
    expect(
      (call('check_import', { from: 'src/llm/a.ts', to: 'src/parser/parse.ts' }) as { verdict: string })
        .verdict,
    ).toBe('allowed');
  });

  it('says cannot-determine for a path it does not know', () => {
    expect(
      (call('check_import', { from: 'src/parser/parse.ts', to: 'src/nope/x.ts' }) as { verdict: string })
        .verdict,
    ).toBe('cannot-determine');
  });

  it('reports a missing argument as a tool error, not a protocol error', () => {
    // The distinction matters to an agent: a protocol error reads as "this
    // server is broken", a tool error as "try something else".
    const response = handleMessage(context(), request('tools/call', { name: 'check_import', arguments: {} }));
    expect('result' in (response as object)).toBe(true);
    expect((response as { result: { isError: boolean } }).result.isError).toBe(true);
  });

  it('reports an unknown tool as a tool error', () => {
    expect((call('write_file', { path: 'x' }) as { isError: boolean }).isError).toBe(true);
  });
});

describe('provenance survives the boundary (rule 2)', () => {
  it('marks derived architecture DERIVED', () => {
    const result = call('get_architecture', {}) as {
      provenance: string;
      modules: { provenance: string }[];
      edges: { provenance: string }[];
    };
    expect(result.provenance).toBe('DERIVED');
    expect(result.modules.every((module) => module.provenance === 'DERIVED')).toBe(true);
    expect(result.edges.every((edge) => edge.provenance === 'DERIVED')).toBe(true);
  });

  it('marks stated constraints STATED', () => {
    const result = call('get_constraints') as {
      provenance: string;
      constraints: { provenance: string }[];
    };
    expect(result.provenance).toBe('STATED');
    expect(result.constraints.every((c) => c.provenance === 'STATED')).toBe(true);
  });

  it('marks violations a comparison, never a fact about either half', () => {
    expect((call('get_violations') as { provenance: string }).provenance).toBe('COMPARISON');
  });

  it('carries evidence on every file edge (rule 3)', () => {
    const result = call('get_architecture', { level: 'file' }) as {
      edges: { evidence: { file: string; line: number }[] }[];
    };
    expect(result.edges.length).toBeGreaterThan(0);
    for (const edge of result.edges) {
      expect(edge.evidence.length).toBeGreaterThan(0);
      expect(edge.evidence[0]?.line).toBeGreaterThan(0);
    }
  });
});

describe('the other read tools', () => {
  it('filters violations by severity and says so', () => {
    expect((call('get_violations', { severity: 'high' }) as { violations: unknown[] }).violations).toHaveLength(1);
    expect((call('get_violations', { severity: 'low' }) as { violations: unknown[] }).violations).toHaveLength(0);
    expect((call('get_violations', { severity: 'low' }) as { filteredBy: string }).filteredBy).toBe('low');
  });

  it('rejects a severity it does not recognise', () => {
    expect((call('get_violations', { severity: 'critical' }) as { isError: boolean }).isError).toBe(true);
  });

  it('surfaces the uncheckable count rather than only the checkable few', () => {
    // Without this an agent sees one constraint and concludes the repository
    // states almost nothing about itself, when in fact most of what it states
    // is simply not decidable from an import graph.
    const result = call('get_constraints') as { uncheckable: { total: number; note: string } };
    expect(result.uncheckable.total).toBe(61);
    expect(result.uncheckable.note).toContain('counted, not enforced');
  });
});
