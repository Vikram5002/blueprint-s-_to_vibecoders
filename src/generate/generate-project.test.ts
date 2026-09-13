import { describe, expect, it } from 'vitest';
import { buildMilestone1Schema, generateMilestone1Project, MILESTONE_1_CONSTRAINT_DSL } from './generate-project.js';
import type { CompletionProvider, CompletionRequest, CompletionResult } from '../llm/provider.js';
import type { CachedLabel, LabelCache } from '../llm/cache.js';

function memoryCache(): LabelCache & { entries: Map<string, CachedLabel> } {
  const entries = new Map<string, CachedLabel>();
  return {
    entries,
    get: (key) => entries.get(key),
    set: (key, value) => void entries.set(key, value),
    flush: async () => true,
    get size() {
      return entries.size;
    },
  };
}

function stubProvider(
  respond: (request: CompletionRequest) => CompletionResult,
): CompletionProvider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    calls,
    name: 'stub',
    model: 'stub-model',
    complete: async (request) => {
      calls.push(request);
      return respond(request);
    },
  };
}

function okResult(code: string): CompletionResult {
  return {
    ok: true,
    value: {
      text: JSON.stringify({ code }),
      model: 'stub-model',
      usage: { promptTokens: 100, completionTokens: 50, cachedPromptTokens: 0 },
    },
  };
}

describe('buildMilestone1Schema', () => {
  const schema = buildMilestone1Schema('session-test', 'test-fixture');

  it('produces a schema that passes its own validation (asserted inside buildMilestone1Schema itself)', () => {
    expect(schema.provenance).toBe('STATED');
  });

  it('scopes to backend + security only - database and frontend stay empty', () => {
    expect(schema.domains.frontend.components).toEqual([]);
    expect(schema.domains.database.components).toEqual([]);
    expect(schema.domains.backend.components).toHaveLength(2);
    expect(schema.domains.security.components).toHaveLength(1);
  });

  it('compiles its one constraint as a resolved, real-path-based rule', () => {
    expect(schema.constraints).toHaveLength(1);
    const constraint = schema.constraints[0];
    expect(constraint?.relation).toBe('must-not-import');
    expect(constraint?.subject.status).toBe('PATH_PATTERN');
    expect(constraint?.subject.target).toBe('backend/src/middleware/**');
    expect(constraint?.object.target).toBe('backend/src/routes/**');
    expect(constraint?.rawText).toBe(MILESTONE_1_CONSTRAINT_DSL);
  });
});

describe('generateMilestone1Project', () => {
  it('generates backend components before security, then assembles the templated files', async () => {
    const provider = stubProvider((request) =>
      okResult(request.user.includes('Domain: security') ? "import { findUserById } from '../routes/user-router';" : 'export default 1;'),
    );
    const schema = buildMilestone1Schema('session-test', 'test-fixture');

    const result = await generateMilestone1Project(schema, { provider, cache: memoryCache() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const paths = result.value.files.map((f) => f.path);
    expect(paths).toContain('package.json');
    expect(paths).toContain('tsconfig.json');
    expect(paths).toContain('backend/src/routes/user-router.ts');
    expect(paths).toContain('backend/src/routes/task-router.ts');
    expect(paths).toContain('backend/src/middleware/auth-middleware.ts');
    expect(paths).toContain('backend/src/index.ts');

    // Backend generated before security: two backend calls happen first.
    expect(provider.calls[0]?.user).toContain('Domain: backend');
    expect(provider.calls[1]?.user).toContain('Domain: backend');
    expect(provider.calls[2]?.user).toContain('Domain: security');

    // The security component's prompt is told it may import UserRouter's file.
    expect(provider.calls[2]?.user).toContain('Allowed local imports:');
    expect(provider.calls[2]?.user).toContain('user-router');

    // And it is shown the one constraint that governs its own directory.
    expect(provider.calls[2]?.user).toContain(MILESTONE_1_CONSTRAINT_DSL);
  });

  it('surfaces which component and domain failed, without silently continuing', async () => {
    const provider = stubProvider(() => ({ ok: false, error: { kind: 'refused', message: 'blocked' } }));
    const schema = buildMilestone1Schema('session-test', 'test-fixture');

    const result = await generateMilestone1Project(schema, { provider, cache: memoryCache() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.domain).toBe('backend');
    expect(result.error.component.name).toBe('UserRouter');
    expect(result.error.failure.reason).toBe('provider-error');
  });
});
