import { describe, expect, it } from 'vitest';
import {
  BEGIN_MARKER,
  END_MARKER,
  renderAgentsMarkdown,
  spliceIntoDocument,
} from './agents-md.js';
import { escapeForScript, escapeHtml, renderStaticHtml } from './static-html.js';
import type { AnalysisContext } from '../server/context.js';

const META = { generatedAt: '2026-08-10T12:00:00.000Z', commit: 'abc1234def5678' };

/**
 * A repository stating one rule that its own code breaks. Small enough to
 * assert on, real enough to exercise every branch of both renderers.
 */
function context(overrides: { failures?: number; constraints?: boolean } = {}): AnalysisContext {
  const { failures = 0, constraints = true } = overrides;

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

  const evidence = [
    { file: 'src/parser/parse.ts', line: 2, snippet: "import x from '../llm/a.js';" },
  ];

  return {
    root: '/repo',
    graph: { graph: { order: 2, size: 1, mapEdges: () => [] }, unresolved: [] },
    clustering: {
      modules: [
        { id: 'm-parser', label: 'm-parser', files: ['src/parser/parse.ts'], directories: ['src/parser'] },
        { id: 'm-llm', label: 'm-llm', files: ['src/llm/a.ts'], directories: ['src/llm'] },
      ],
      edges: [],
      assignments: [],
      summary: { moduleCount: 2 },
    },
    labels: { labels: new Map(), summary: {} },
    intent: {
      constraints: constraints ? [constraint] : [],
      uncheckable: [],
      failures: Array.from({ length: failures }, (_, i) => ({
        location: `doc-${i}.md`,
        reason: 'quota exhausted',
      })),
      summary: {
        documents: 1,
        uncheckable: 61,
        byUncheckableReason: { 'style-preference': 61 },
        incompleteDocuments: 0,
        degraded: false,
      },
    },
    conformance: {
      violations: constraints
        ? [
            {
              id: 'v-1',
              constraintId: 'c-1',
              kind: 'forbidden-import',
              severity: 'high',
              severityScore: 0.81,
              severityFactors: [],
              explanation: 'the parser imports the model adapter.',
              cycle: [],
              edges: [
                {
                  edgeId: 'e1',
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
          ]
        : [],
      unchecked: [],
      summary: {
        constraints: constraints ? 1 : 0,
        checked: constraints ? 1 : 0,
        satisfied: 0,
        unchecked: 0,
        violated: constraints ? 1 : 0,
        violations: constraints ? 1 : 0,
        bySeverity: { high: constraints ? 1 : 0, medium: 0, low: 0 },
        byKind: {},
        byUncheckedReason: {},
        implicatedEdges: constraints ? 1 : 0,
      },
    },
  } as unknown as AnalysisContext;
}

// ---------------------------------------------------------------- AGENTS.md

describe('the AGENTS.md export', () => {
  it('is readable by a human and parseable by a machine from the same file', () => {
    const markdown = renderAgentsMarkdown(context(), META);

    // Human half.
    expect(markdown).toContain('## Architecture (measured)');
    expect(markdown).toContain('### Stated rules');
    expect(markdown).toContain('parser/ must NEVER import from llm/.');

    // Machine half: one fenced block, tagged, containing valid JSON.
    const match = /```json blueprint:constraints\n([\s\S]*?)\n```/.exec(markdown);
    expect(match).not.toBeNull();
    const parsed = JSON.parse((match as RegExpExecArray)[1] as string) as {
      constraints: { provenance: string }[];
      violations: { provenance: string; edges: { evidence: string[] }[] }[];
      modules: { provenance: string }[];
    };

    expect(parsed.constraints[0]?.provenance).toBe('STATED');
    expect(parsed.modules[0]?.provenance).toBe('DERIVED');
    expect(parsed.violations[0]?.provenance).toBe('COMPARISON');
  });

  it('carries evidence through to the export (rule 3)', () => {
    const markdown = renderAgentsMarkdown(context(), META);
    const match = /```json blueprint:constraints\n([\s\S]*?)\n```/.exec(markdown);
    const parsed = JSON.parse((match as RegExpExecArray)[1] as string) as {
      violations: { edges: { evidence: string[] }[] }[];
    };
    expect(parsed.violations[0]?.edges[0]?.evidence).toEqual(['src/parser/parse.ts:2']);
    // And in the prose half too, where a human will actually look.
    expect(markdown).toContain('src/parser/parse.ts:2');
  });

  it('stamps when it was measured and from what', () => {
    const markdown = renderAgentsMarkdown(context(), META);
    expect(markdown).toContain(META.generatedAt);
    expect(markdown).toContain('abc1234def5678');
  });

  it('says an empty list is unread rather than absent when reading failed', () => {
    const markdown = renderAgentsMarkdown(context({ failures: 1, constraints: false }), META);
    expect(markdown).toContain('incomplete');
    expect(markdown).not.toContain('stated no dependency rule that can be checked');
  });

  it('never merges the two halves of the data model', () => {
    const markdown = renderAgentsMarkdown(context(), META);
    expect(markdown).toContain('They are never merged.');
  });
});

describe('splicing into an existing document', () => {
  it('appends a block to a file that has never been exported to', () => {
    const result = spliceIntoDocument('# My notes\n\nHand-written.\n', renderAgentsMarkdown(context(), META));
    expect(result).toContain('# My notes');
    expect(result).toContain('Hand-written.');
    expect(result).toContain(BEGIN_MARKER);
  });

  it('replaces only what is between the markers, twice over', () => {
    // The property that matters: exporting repeatedly must not accumulate
    // blocks or eat the developer's own prose.
    const first = spliceIntoDocument('# Mine\n\nKeep me.\n', `${BEGIN_MARKER}\nold\n${END_MARKER}`);
    const second = spliceIntoDocument(first, `${BEGIN_MARKER}\nnew\n${END_MARKER}`);

    expect(second).toContain('Keep me.');
    expect(second).toContain('new');
    expect(second).not.toContain('old');
    expect(second.split(BEGIN_MARKER)).toHaveLength(2);
  });

  it('writes a clean file when there was nothing there', () => {
    const result = spliceIntoDocument('', `${BEGIN_MARKER}\nx\n${END_MARKER}`);
    expect(result.startsWith(BEGIN_MARKER)).toBe(true);
  });
});

// ---------------------------------------------------------------- static HTML

describe('the static HTML export', () => {
  const html = renderStaticHtml(context(), META);

  it('is a complete self-contained document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
  });

  it('requests nothing from the network', () => {
    /**
     * The acceptance requirement is zero console errors from `file://`, and
     * the way that breaks is a stray CDN link or a fetch to an API that is not
     * there. Also a privacy property: this tool reads private source, so an
     * export that phoned anywhere would be a leak wearing a report's clothes.
     */
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).not.toMatch(/XMLHttpRequest|EventSource|WebSocket/);
    expect(html).not.toMatch(/<link[^>]+href|<script[^>]+src=/);
  });

  it('shows when it was generated and from which commit', () => {
    // A static file outlives the run that made it; without this a reader
    // cannot tell whether they are looking at today's measurement.
    expect(html).toContain(META.generatedAt);
    expect(html).toContain('abc1234def5678');
  });

  it('says so when there is no commit rather than inventing one', () => {
    const withoutGit = renderStaticHtml(context(), { ...META, commit: null });
    expect(withoutGit).toContain('not a git repository');
  });

  it('keeps DERIVED and STATED visually distinct', () => {
    expect(html).toContain('chip derived');
    expect(html).toContain('chip stated');
    expect(html).toContain('They are never merged.');
  });

  it('embeds evidence, not just a claim', () => {
    expect(html).toContain('src/parser/parse.ts');
  });

  it('explains an empty violation list instead of showing a bare zero', () => {
    const clean = renderStaticHtml(context({ constraints: false }), META);
    expect(clean).toContain('not measured');
  });
});

describe('embedding untrusted source text in the page', () => {
  it('cannot be broken out of with a script tag from the analysed repository', () => {
    /**
     * A repository that renders HTML will contain the characters `</script>`
     * in a source line, and that snippet ends up in the evidence we embed. It
     * would close the element regardless of the JSON string it sits inside.
     */
    expect(escapeForScript('</script><script>alert(1)</script>')).not.toContain('</script>');
    expect(escapeForScript('{"a":"</script>"}')).toContain('\\u003c');
  });

  it('escapes the line separators that are newlines to JS but not to JSON', () => {
    expect(escapeForScript('a\u2028b')).toBe('a\\u2028b');
    expect(escapeForScript('a\u2029b')).toBe('a\\u2029b');
  });

  it('round-trips as valid JSON once embedded', () => {
    const payload = { snippet: "</script> & <b>' \u2028" };
    const embedded = escapeForScript(JSON.stringify(payload));
    // The browser parses the *unescaped* text content; JSON.parse handles the
    // \u escapes we introduced, so the value must survive intact.
    expect(JSON.parse(embedded)).toEqual(payload);
  });

  it('escapes html in attribute and text positions', () => {
    expect(escapeHtml('<b>"&"</b>')).toBe('&lt;b&gt;&quot;&amp;&quot;&lt;/b&gt;');
  });
});
