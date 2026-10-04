import { describe, expect, it, vi } from 'vitest';
import type { CompletionProvider, CompletionRequest } from '../llm/provider.js';
import {
  buildReworkPrompt,
  checkProposal,
  importSpecifiers,
  MAX_REWORK_SOURCE_CHARS,
  reachesForbidden,
  relativeSpecifier,
  reworkFile,
  type ReworkRequest,
} from './rework-file.js';

const ORIGINAL = [
  "import { Router } from 'express';",
  "import { findUser } from '../db/users-table';",
  '',
  'export const router = Router();',
  "router.get('/users/:id', (req, res) => res.json(findUser(req.params.id)));",
  '',
].join('\n');

const FIXED = [
  "import { Router } from 'express';",
  "import { getUser } from '../services/user-service';",
  '',
  'export const router = Router();',
  "router.get('/users/:id', (req, res) => res.json(getUser(req.params.id)));",
  '',
].join('\n');

const REQUEST: ReworkRequest = {
  path: 'src/routes/users.ts',
  source: ORIGINAL,
  violations: [
    {
      ruleText: 'routes must not import db',
      explanation: 'src/routes/users.ts imports src/db/users-table.ts',
      evidence: [{ line: 2, snippet: "import { findUser } from '../db/users-table';" }],
      forbidden: ['src/db'],
    },
  ],
  rules: ['routes must not import db', 'services may import db'],
};

function providerAnswering(text: string): CompletionProvider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-model',
    calls,
    complete: vi.fn(async (request: CompletionRequest) => {
      calls.push(request);
      return { ok: true as const, value: { text, model: 'fake-model', usage: { promptTokens: 1, completionTokens: 1 } } };
    }),
  } as CompletionProvider & { calls: CompletionRequest[] };
}

describe('reworkFile', () => {
  it('returns the proposal and marks the violating import as gone', async () => {
    const provider = providerAnswering(JSON.stringify({ code: FIXED }));
    const result = await reworkFile(provider, REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposed).toBe(FIXED);
    expect(result.value.unchanged).toBe(false);
    expect(result.value.checks).toEqual([
      expect.objectContaining({ line: 2, lookedFor: '../db/users-table', stillPresent: false }),
    ]);
  });

  it('reports a violation the model left in place - the model is not trusted on its word', async () => {
    const provider = providerAnswering(JSON.stringify({ code: ORIGINAL.replace('findUser(', 'findUser (') }));
    const result = await reworkFile(provider, REQUEST);
    expect(result.ok && result.value.checks[0]?.stillPresent).toBe(true);
  });

  it('sends the file, the violation lines and every stated rule to the model', async () => {
    const provider = providerAnswering(JSON.stringify({ code: FIXED }));
    await reworkFile(provider, { ...REQUEST, instruction: 'keep it short' });
    const user = provider.calls[0]?.user ?? '';
    expect(user).toContain("src/routes/users.ts:2: import { findUser } from '../db/users-table';");
    expect(user).toContain('- services may import db');
    expect(user).toContain('The developer also asks: keep it short');
    expect(user).toContain(ORIGINAL);
  });

  it('refuses when there is no violation and no instruction, without calling the model', async () => {
    const provider = providerAnswering('{}');
    const result = await reworkFile(provider, { ...REQUEST, violations: [] });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ reason: 'nothing-to-do' }) });
    expect(provider.calls).toHaveLength(0);
  });

  it('refuses a file too long to come back in one answer', async () => {
    const provider = providerAnswering('{}');
    const result = await reworkFile(provider, { ...REQUEST, source: 'x'.repeat(MAX_REWORK_SOURCE_CHARS + 1) });
    expect(!result.ok && result.error.reason).toBe('too-large');
  });

  it('passes a provider failure through, and flags an unparseable answer', async () => {
    const failing: CompletionProvider = {
      name: 'fake',
      model: 'm',
      complete: async () => ({ ok: false, error: { kind: 'unavailable', message: 'quota exhausted' } }),
    };
    expect(await reworkFile(failing, REQUEST)).toEqual({ ok: false, error: { reason: 'provider-error', message: 'quota exhausted' } });
    const garbled = await reworkFile(providerAnswering('not json'), REQUEST);
    expect(!garbled.ok && garbled.error.reason).toBe('unparseable-json');
  });

  it('says when the proposal is the original file', async () => {
    const result = await reworkFile(providerAnswering(JSON.stringify({ code: `${ORIGINAL}\n\n` })), REQUEST);
    expect(result.ok && result.value.unchanged).toBe(true);
  });
});

describe('importSpecifiers', () => {
  it('reads TypeScript, CommonJS, dynamic, re-export, Python and PHP forms', () => {
    const source = [
      "import a from 'a';",
      "import { b } from \"./b\";",
      "import './side-effect';",
      "const c = require('c');",
      "const d = await import('./d');",
      "export { e } from '../e';",
      'from app.db import session',
      'import os.path',
      'use App\\Models\\User;',
    ].join('\n');
    expect(importSpecifiers(source)).toEqual(['a', './b', './side-effect', 'c', './d', '../e', 'app.db', 'os.path', 'App\\Models\\User']);
  });
});

describe('checkProposal', () => {
  it('falls back to the exact line when no specifier can be read from the evidence', () => {
    const violations = [{ ruleText: 'r', explanation: 'e', evidence: [{ line: 3, snippet: 'db.query(sql)' }] }];
    expect(checkProposal(violations, 'x\n  db.query(sql)\n')[0]?.stillPresent).toBe(true);
    expect(checkProposal(violations, 'x\nservice.query(sql)\n')[0]?.stillPresent).toBe(false);
  });

  it('builds a prompt that says so when nothing is broken', () => {
    expect(buildReworkPrompt({ ...REQUEST, violations: [], rules: [], instruction: 'rename x' })).toContain(
      'Architecture rules this file breaks: none found.',
    );
  });
});

describe('the forbidden module under another spelling', () => {
  it('a require of the same file is not a fix (found live with a real model)', () => {
    const cheat = ['export function f(id: string) {', "  const { findUser } = require('../db/users-table');", '  return findUser(id);', '}', ''].join('\n');
    const [check] = checkProposal(REQUEST.violations, cheat, REQUEST.path);
    expect(check).toMatchObject({ stillPresent: true, lookedFor: '../db/users-table' });
  });

  it('another file of the forbidden folder is not a fix either', () => {
    const other = ["import { q } from '../db/connection';", 'export const f = q;', ''].join('\n');
    expect(checkProposal(REQUEST.violations, other, REQUEST.path)[0]).toMatchObject({ stillPresent: true, lookedFor: '../db/connection' });
  });

  it('reachesForbidden resolves relative paths and ignores packages', () => {
    expect(reachesForbidden('src/routes/a.ts', '../db', ['src/db'])).toBe(true);
    expect(reachesForbidden('src/routes/a.ts', '../db/x.js', ['src/db/x.ts'])).toBe(true);
    expect(reachesForbidden('src/routes/a.ts', '../dbx/y', ['src/db'])).toBe(false);
    expect(reachesForbidden('src/routes/a.ts', 'db', ['src/db'])).toBe(false);
  });

  it('relativeSpecifier writes the import a file would use', () => {
    expect(relativeSpecifier('src/routes/a.ts', 'src/services/user-service.ts')).toBe('../services/user-service');
    expect(relativeSpecifier('src/a.ts', 'src/b.tsx')).toBe('./b');
  });

  it('puts helper files and their exports in the prompt', () => {
    const prompt = buildReworkPrompt({ ...REQUEST, helpers: [{ path: 'src/services/user-service.ts', exports: ['getUser'] }] });
    expect(prompt).toContain('- ../services/user-service exports: getUser');
  });
});
