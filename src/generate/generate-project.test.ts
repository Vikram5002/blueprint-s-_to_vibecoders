import { describe, expect, it } from 'vitest';
import {
  buildMilestone1Schema,
  buildMilestone2Schema,
  buildScaleTestSchema,
  generateMilestone1Project,
  generateProject,
  MILESTONE_1_CONSTRAINT_DSL,
  MILESTONE_2_CONSTRAINT_DSL,
  SCALE_TEST_CONSTRAINT_DSL_1,
  SCALE_TEST_CONSTRAINT_DSL_2,
  schemaImpliesDatabase,
} from './generate-project.js';
import { validateProjectSchema } from '../workflow/validate-project-schema.js';
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

function schemaWith(database: { components: number; dependsOnDatabase: readonly ('backend' | 'frontend')[] }) {
  const dbComponents = Array.from({ length: database.components }, (_unused, i) => ({
    id: `db-${i}`,
    name: `Table${i}`,
    purpose: 'x',
  }));
  return {
    sessionId: 's',
    title: 't',
    originalPrompt: 'p',
    domains: {
      frontend: { components: [], dependsOn: database.dependsOnDatabase.includes('frontend') ? ['database'] : [] },
      backend: { components: [], dependsOn: database.dependsOnDatabase.includes('backend') ? ['database'] : [] },
      database: { components: dbComponents, dependsOn: [] },
      security: { components: [], dependsOn: [] },
    },
    constraints: [],
    provenance: 'STATED' as const,
  };
}

describe('schemaImpliesDatabase (Task 1 heuristic)', () => {
  it('is false when there are no database components, even if something depends on it', () => {
    const result = validateProjectSchema(schemaWith({ components: 0, dependsOnDatabase: ['backend'] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(schemaImpliesDatabase(result.value)).toBe(false);
  });

  it('is false when components exist but nothing depends on the database domain', () => {
    const result = validateProjectSchema(schemaWith({ components: 1, dependsOnDatabase: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(schemaImpliesDatabase(result.value)).toBe(false);
  });

  it('is true when a component exists and backend depends on it', () => {
    const result = validateProjectSchema(schemaWith({ components: 1, dependsOnDatabase: ['backend'] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(schemaImpliesDatabase(result.value)).toBe(true);
  });

  it('is true when a component exists and only frontend depends on it', () => {
    const result = validateProjectSchema(schemaWith({ components: 1, dependsOnDatabase: ['frontend'] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(schemaImpliesDatabase(result.value)).toBe(true);
  });
});

describe('buildMilestone2Schema', () => {
  const schema = buildMilestone2Schema('session-test', 'test-fixture');

  it('inverts which domains are populated relative to Milestone 1: database + frontend real, security empty', () => {
    expect(schema.domains.database.components).toHaveLength(1);
    expect(schema.domains.backend.components).toHaveLength(1);
    expect(schema.domains.frontend.components).toHaveLength(1);
    expect(schema.domains.security.components).toEqual([]);
  });

  it('declares real dependsOn edges: backend on database, frontend on backend', () => {
    expect(schema.domains.backend.dependsOn).toEqual(['database']);
    expect(schema.domains.frontend.dependsOn).toEqual(['backend']);
  });

  it('the database domain is implied per the Task 1 heuristic', () => {
    expect(schemaImpliesDatabase(schema)).toBe(true);
  });

  it('compiles its one constraint against the real backend/src/routes vs backend/src/db split', () => {
    const constraint = schema.constraints[0];
    expect(constraint?.subject.target).toBe('backend/src/routes/**');
    expect(constraint?.object.target).toBe('backend/src/db/**');
    expect(constraint?.rawText).toBe(MILESTONE_2_CONSTRAINT_DSL);
  });
});

describe('generateProject (Milestone 2, general orchestrator)', () => {
  it('generates database before backend before frontend, wiring real cross-domain import paths', async () => {
    const provider = stubProvider(() => okResult('placeholder'));
    const schema = buildMilestone2Schema('session-test', 'test-fixture');

    const result = await generateProject(schema, { provider, cache: memoryCache() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const paths = result.value.files.map((f) => f.path);
    expect(paths).toContain('backend/src/db/recipe-store.ts');
    expect(paths).toContain('backend/src/routes/recipe-router.ts');
    expect(paths).toContain('frontend/src/pages/recipe-list-page.tsx');
    expect(paths).toContain('frontend/src/main.tsx');

    expect(provider.calls[0]?.user).toContain('Domain: database');
    expect(provider.calls[1]?.user).toContain('Domain: backend');
    expect(provider.calls[2]?.user).toContain('Domain: frontend');

    // Backend's RecipeRouter is told it may import the real database file it depends on.
    expect(provider.calls[1]?.user).toContain('Allowed local imports:');
    expect(provider.calls[1]?.user).toContain('recipe-store');
    expect(provider.calls[1]?.user).toContain(MILESTONE_2_CONSTRAINT_DSL);

    // Frontend's page has no local import permissions - it only ever calls the backend over HTTP,
    // at the REAL route path the backend router was actually mounted at.
    expect(provider.calls[2]?.user).toContain('Allowed local imports: none');
    expect(provider.calls[2]?.user).toContain('/api/recipe-router');

    // package.json/tsconfig reflect the database domain (node:sqlite is built
    // in, so no dependency entry - just the engines floor and newer @types/node)
    // and the frontend domain being present.
    const pkg = JSON.parse(result.value.files.find((f) => f.path === 'package.json')?.contents ?? '{}');
    expect(pkg.dependencies['better-sqlite3']).toBeUndefined();
    expect(pkg.engines).toEqual({ node: '>=22.5.0' });
    expect(pkg.dependencies.react).toBeDefined();

    // The database component's prompt targets node:sqlite's real API.
    expect(provider.calls[0]?.user).toContain('node:sqlite');
    expect(provider.calls[0]?.user).toContain('Available npm packages: node:sqlite');
  });

  it('skips database generation entirely when the Task 1 heuristic says it is not implied', async () => {
    const provider = stubProvider(() => okResult('placeholder'));
    const candidate = schemaWith({ components: 1, dependsOnDatabase: [] });
    const validated = validateProjectSchema(candidate);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const result = await generateProject(validated.value, { provider, cache: memoryCache() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files.some((f) => f.path.startsWith('backend/src/db/'))).toBe(false);
    const pkg = JSON.parse(result.value.files.find((f) => f.path === 'package.json')?.contents ?? '{}');
    expect(pkg.engines).toBeUndefined();
  });
});

describe('buildScaleTestSchema', () => {
  const schema = buildScaleTestSchema('session-test', 'test-fixture');

  it('has at least 3x Milestone 2\'s component count, spanning all four domains', () => {
    const total =
      schema.domains.frontend.components.length +
      schema.domains.backend.components.length +
      schema.domains.database.components.length +
      schema.domains.security.components.length;
    expect(total).toBeGreaterThanOrEqual(9);
    expect(schema.domains.database.components.length).toBeGreaterThan(0);
    expect(schema.domains.backend.components.length).toBeGreaterThan(0);
    expect(schema.domains.security.components.length).toBeGreaterThan(0);
    expect(schema.domains.frontend.components.length).toBeGreaterThan(0);
  });

  it('has at least two real, independently-resolved constraints', () => {
    expect(schema.constraints.length).toBeGreaterThanOrEqual(2);
    for (const constraint of schema.constraints) {
      expect(constraint.subject.status).toBe('PATH_PATTERN');
      expect(constraint.object.status).toBe('PATH_PATTERN');
    }
    const rawTexts = schema.constraints.map((c) => c.rawText);
    expect(rawTexts).toContain(SCALE_TEST_CONSTRAINT_DSL_1);
    expect(rawTexts).toContain(SCALE_TEST_CONSTRAINT_DSL_2);
  });

  it('the database domain is implied per the Task 1 heuristic, same as Milestone 2', () => {
    expect(schemaImpliesDatabase(schema)).toBe(true);
  });

  it('every component has a distinct id - no accidental collisions across this schema\'s 9 components', () => {
    const ids = [
      ...schema.domains.frontend.components,
      ...schema.domains.backend.components,
      ...schema.domains.database.components,
      ...schema.domains.security.components,
    ].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
