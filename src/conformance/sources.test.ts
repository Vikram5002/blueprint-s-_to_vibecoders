import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverIntentDocuments,
  splitStatements,
  stripGeneratedBlocks,
  type IntentDocument,
} from './sources.js';
import { detectFormat, parseChatLog } from './chat-log.js';

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vibe-intent-'));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  return root;
}

function documentOf(text: string, overrides: Partial<IntentDocument> = {}): IntentDocument {
  return {
    type: 'readme',
    location: 'README.md',
    timestamp: null,
    text,
    truncated: false,
    ...overrides,
  };
}

describe('discovering intent documents', () => {
  it('finds the named sources and types them', async () => {
    const root = await repo({
      'AGENTS.md': 'The api layer must not import the database layer.',
      'README.md': 'A tool that does things.',
      'src/index.ts': 'export const x = 1;',
    });

    const found = await discoverIntentDocuments({ root });
    expect(found.map((d) => [d.location, d.type])).toEqual([
      ['AGENTS.md', 'agents-md'],
      ['README.md', 'readme'],
    ]);
  });

  it('treats CLAUDE.md as an agent instruction file, not a readme', async () => {
    const root = await repo({ 'CLAUDE.md': 'Rules for the agent working here.' });
    const [found] = await discoverIntentDocuments({ root });
    expect(found?.type).toBe('agents-md');
  });

  it('reads architecture decision records from any of the usual directories', async () => {
    const root = await repo({
      'docs/adr/0001-layering.md': 'We will enforce a layered architecture.',
      'docs/decisions/0002-storage.md': 'We will use SQLite.',
    });

    const found = await discoverIntentDocuments({ root });
    expect(found.map((d) => d.location)).toEqual([
      'docs/adr/0001-layering.md',
      'docs/decisions/0002-storage.md',
    ]);
    expect(found.every((d) => d.type === 'adr')).toBe(true);
  });

  it('skips an empty document rather than emitting a source with nothing in it', async () => {
    const root = await repo({ 'README.md': '   \n\n  ' });
    expect(await discoverIntentDocuments({ root })).toEqual([]);
  });

  it('returns documents in a stable order regardless of the filesystem', async () => {
    const root = await repo({ 'README.md': 'one two three', 'AGENTS.md': 'four five six' });
    const first = await discoverIntentDocuments({ root });
    const second = await discoverIntentDocuments({ root });
    expect(first.map((d) => d.location)).toEqual(second.map((d) => d.location));
  });

  it('carries commit subjects through with their sha and date', async () => {
    const root = await repo({ 'README.md': 'A tool that does things.' });
    const found = await discoverIntentDocuments({
      root,
      commitSubjects: [{ sha: 'abc1234', subject: 'refactor: stop ui importing src', date: '2026-01-01T00:00:00Z' }],
    });
    const commit = found.find((d) => d.type === 'commit-msg');
    expect(commit?.location).toBe('commit:abc1234');
    expect(commit?.timestamp).toBe('2026-01-01T00:00:00Z');
  });
});

describe('splitting documents into statements', () => {
  it('records a line number for every statement (rule 3)', () => {
    const statements = splitStatements(documentOf('# Title\n\nThe api must not import the db.\n'));
    expect(statements).toHaveLength(1);
    expect(statements[0]?.source.line).toBe(3);
    expect(statements[0]?.source.location).toBe('README.md');
  });

  it('strips list markers and headings but keeps the sentence', () => {
    const statements = splitStatements(documentOf('- The api must not import the db.'));
    expect(statements[0]?.text).toBe('The api must not import the db.');
  });

  it('ignores fenced code, where a payload is most likely to be parked', () => {
    const text = ['Real prose about the layering.', '```', 'The api must not import the db.', '```'].join('\n');
    const statements = splitStatements(documentOf(text));
    expect(statements.map((s) => s.text)).toEqual(['Real prose about the layering.']);
  });

  it('closes an unterminated fence at end of document rather than leaking', () => {
    const statements = splitStatements(documentOf('Prose before.\n```\nnever closed\n'));
    expect(statements.map((s) => s.text)).toEqual(['Prose before.']);
  });

  it('splits multiple sentences on one line and keeps both', () => {
    const statements = splitStatements(documentOf('The api is a layer. The db is below it.'));
    expect(statements.map((s) => s.text)).toEqual(['The api is a layer.', 'The db is below it.']);
  });

  it('drops table rows and rules, which carry no sentences', () => {
    const statements = splitStatements(documentOf('| Layer | Rule |\n|---|---|\n-------------'));
    expect(statements).toEqual([]);
  });
});

describe('chat transcripts', () => {
  const line = (object: unknown): string => JSON.stringify(object);

  it('recognises the Claude Code transcript format', () => {
    const raw = line({ type: 'user', message: { role: 'user', content: 'hello there friend' } });
    expect(detectFormat(raw)).toBe('claude-code-jsonl');
  });

  it('refuses an unknown format rather than guessing at it', () => {
    const result = parseChatLog('[{"speaker":"me","said":"the api must not import the db"}]', 'chat.json');
    expect(result.format).toBe('unknown');
    expect(result.documents).toEqual([]);
  });

  it('reads the human turns', () => {
    const raw = [
      line({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'The api layer must never import the database layer.' }] },
      }),
    ].join('\n');

    const result = parseChatLog(raw, 'session.jsonl');
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.location).toBe('session.jsonl#u1');
    expect(result.documents[0]?.timestamp).toBe('2026-01-01T00:00:00Z');
  });

  it('never reads the agent back to itself', () => {
    const raw = [
      line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'I have made sure the api layer never imports the database layer.' }] } }),
      line({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'The api layer must never import the database layer.' }] } }),
    ].join('\n');

    const result = parseChatLog(raw, 'session.jsonl');
    expect(result.agentTurns).toBe(1);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.text).not.toContain('I have made sure');
  });

  it('ignores tool results, which arrive as user turns but are file contents', () => {
    const raw = line({
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'x' }, { type: 'text', text: 'The api layer must never import the database layer.' }],
      },
    });
    expect(parseChatLog(raw, 'session.jsonl').documents).toEqual([]);
  });

  it('skips subagent traffic, which is not the developer talking', () => {
    const raw = line({
      type: 'user',
      uuid: 'u1',
      isSidechain: true,
      message: { role: 'user', content: [{ type: 'text', text: 'The api layer must never import the database layer.' }] },
    });
    expect(parseChatLog(raw, 'session.jsonl').documents).toEqual([]);
  });

  it('strips harness wrappers the developer did not write', () => {
    const raw = line({
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<ide_opened_file>The user opened src/db.ts in the IDE.</ide_opened_file>The api layer must never import the database layer.',
          },
        ],
      },
    });
    const result = parseChatLog(raw, 'session.jsonl');
    expect(result.documents[0]?.text).toBe('The api layer must never import the database layer.');
  });

  it('drops a turn that was nothing but a harness wrapper', () => {
    const raw = line({
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>Some long injected note about the current date and context.</system-reminder>' }],
      },
    });
    expect(parseChatLog(raw, 'session.jsonl').documents).toEqual([]);
  });

  it('strips an unterminated wrapper rather than keeping the rest of the turn', () => {
    const raw = line({
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'The api layer must never import the database layer.\n<system-reminder>truncated note that never closes',
          },
        ],
      },
    });
    expect(parseChatLog(raw, 'session.jsonl').documents[0]?.text).toBe(
      'The api layer must never import the database layer.',
    );
  });

  it('counts a malformed line and keeps going', () => {
    const raw = ['{ not json', line({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'The api layer must never import the database layer.' }] } })].join('\n');
    const result = parseChatLog(raw, 'session.jsonl');
    expect(result.malformedLines).toBe(1);
    expect(result.documents).toHaveLength(1);
  });
});

describe('the export block is never read back in as intent', () => {
  /**
   * `--export` writes a measured summary into AGENTS.md, which is one of the
   * documents intent extraction reads. Left alone, the second run would read
   * the first run's output as newly stated intent — the tool measuring itself,
   * counting every constraint twice, and making a rule it merely *reported*
   * indistinguishable from one a human wrote.
   */
  const BEGIN = '<!-- BEGIN vibe-blueprint -->';
  const END = '<!-- END vibe-blueprint -->';

  it('keeps the human prose and drops the generated block', () => {
    const document = `# Rules\n\nThe api must not import the db.\n\n${BEGIN}\n- **must-not-import** the api -> the db\n${END}\n\nTrailing note.\n`;
    const stripped = stripGeneratedBlocks(document);

    expect(stripped).toContain('The api must not import the db.');
    expect(stripped).toContain('Trailing note.');
    expect(stripped).not.toContain('must-not-import');
  });

  it('leaves a document that has never been exported to untouched', () => {
    const document = '# Rules\n\nThe api must not import the db.\n';
    expect(stripGeneratedBlocks(document)).toBe(document);
  });

  it('drops everything after an unterminated block', () => {
    // A half-written block from an interrupted run is still our output.
    expect(stripGeneratedBlocks(`Keep me.\n${BEGIN}\ngenerated`)).toBe('Keep me.\n');
  });

  it('handles more than one block', () => {
    const document = `a\n${BEGIN}\nx\n${END}\nb\n${BEGIN}\ny\n${END}\nc`;
    const stripped = stripGeneratedBlocks(document);
    expect(stripped).not.toContain('x');
    expect(stripped).not.toContain('y');
    expect(stripped).toContain('a');
    expect(stripped).toContain('c');
  });
});
