import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CompletionProvider, CompletionRequest } from '../llm/provider.js';
import type { AnalysisContext } from './context.js';

// The violation list is the analysis's job (tested in violations-api); here it
// is stubbed so these tests are about the route: paths, scoping and status codes.
vi.mock('./violations-api.js', () => ({
  buildViolationsResponse: () => ({
    violations: [
      {
        constraint: { rawText: 'routes must not import db' },
        explanation: 'routes/users.ts imports db/users.ts',
        edges: [
          {
            fromFile: 'routes/users.ts',
            evidence: [
              { file: 'routes/users.ts', line: 1, snippet: "import { findUser } from '../db/users';" },
              { file: 'routes/other.ts', line: 9, snippet: 'not this file' },
            ],
          },
          { fromFile: 'routes/other.ts', evidence: [{ file: 'routes/other.ts', line: 2, snippet: "import '../db/x';" }] },
        ],
      },
    ],
  }),
}));

const { createReworkRoutes, normaliseRepoPath } = await import('./rework-api.js');

const SOURCE = "import { findUser } from '../db/users';\nexport const a = findUser;\n";
const FIXED = "import { getUser } from '../services/users';\nexport const a = getUser;\n";

let root: string;
const calls: CompletionRequest[] = [];
const provider: CompletionProvider = {
  name: 'fake',
  model: 'fake',
  complete: async (request) => {
    calls.push(request);
    return { ok: true, value: { text: JSON.stringify({ code: FIXED }), model: 'fake', usage: { promptTokens: 1, completionTokens: 1 } } };
  },
};

function app(withProvider: CompletionProvider | null) {
  const context = { root, intent: { constraints: [{ rawText: 'services may import db' }] } } as unknown as AnalysisContext;
  return createReworkRoutes({ context: () => context, provider: withProvider });
}

function post(withProvider: CompletionProvider | null, body: unknown) {
  return app(withProvider).request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vibe-rework-'));
  await mkdir(join(root, 'routes'));
  await writeFile(join(root, 'routes', 'users.ts'), SOURCE);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('POST /api/rework', () => {
  it('reads the file, sends only that file\'s violations, and returns the checked proposal', async () => {
    const response = await post(provider, { path: 'routes/users.ts' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ path: 'routes/users.ts', proposed: FIXED, unchanged: false });
    expect(body['checks']).toEqual([expect.objectContaining({ line: 1, lookedFor: '../db/users', stillPresent: false })]);
    expect(body['violations']).toEqual([
      { ruleText: 'routes must not import db', explanation: 'routes/users.ts imports db/users.ts', evidence: [{ line: 1, snippet: "import { findUser } from '../db/users';" }] },
    ]);
    const user = calls.at(-1)?.user ?? '';
    expect(user).not.toContain('not this file');
    expect(user).toContain('- services may import db');
  });

  it('uses the unsaved text the editor sends instead of the file on disk', async () => {
    await post(provider, { path: 'routes/users.ts', source: '// unsaved edit\n' + SOURCE });
    expect(calls.at(-1)?.user).toContain('// unsaved edit');
  });

  it('refuses a path outside the project, and a missing file', async () => {
    expect((await post(provider, { path: '../../etc/passwd' })).status).toBe(400);
    expect((await post(provider, { path: 'routes/missing.ts' })).status).toBe(404);
    expect((await post(provider, { nope: 1 })).status).toBe(400);
  });

  it('answers 503 with no model, and 422 when there is nothing to do', async () => {
    expect((await post(null, { path: 'routes/users.ts' })).status).toBe(503);
    await writeFile(join(root, 'clean.ts'), 'export const b = 1;\n');
    const response = await post(provider, { path: 'clean.ts' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ reason: 'nothing-to-do' });
  });
});

describe('GET /api/rework/violations', () => {
  it('lists the rules one file breaks', async () => {
    const response = await app(null).request('/violations?path=routes/users.ts');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { violations: unknown[] }).violations).toHaveLength(1);
  });
});

describe('normaliseRepoPath', () => {
  it('keeps paths inside the root and refuses the rest', () => {
    expect(normaliseRepoPath('/repo', 'src\\a.ts')).toBe('src/a.ts');
    expect(normaliseRepoPath('/repo', '../x')).toBeNull();
    expect(normaliseRepoPath('/repo', '')).toBeNull();
  });
});
