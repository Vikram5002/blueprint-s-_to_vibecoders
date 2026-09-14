import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateAndVerifyProject } from './verify-and-regenerate.js';
import { componentId, type Component, type ValidatedProjectSchema } from '../types/project-schema.js';
import { compileBlueprint } from '../blueprint/dsl.js';
import { validateProjectSchema } from '../workflow/validate-project-schema.js';
import type { CompletionProvider, CompletionRequest } from '../llm/provider.js';
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

function providerFrom(
  respond: (request: CompletionRequest) => string,
): CompletionProvider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    calls,
    name: 'stub',
    model: 'stub-model',
    complete: async (request) => {
      calls.push(request);
      return {
        ok: true,
        value: {
          text: JSON.stringify({ code: respond(request) }),
          model: 'stub-model',
          usage: { promptTokens: 10, completionTokens: 10, cachedPromptTokens: 0 },
        },
      };
    },
  };
}

/**
 * The same deliberate tension Milestones 1 and 2 each found by accident: a
 * security component whose stated purpose requires calling a function
 * defined in a domain a constraint forbids it from importing at all.
 */
const USER_ROUTER: Component = {
  id: componentId('backend', 'UserRouter', 'user-router'),
  name: 'UserRouter',
  purpose: 'Exports a findUserById(id) helper function for other backend code to reuse.',
};

const AUTH_MIDDLEWARE: Component = {
  id: componentId('security', 'AuthMiddleware', 'auth-middleware'),
  name: 'AuthMiddleware',
  purpose:
    "Verifies the requester is a real user by calling the UserRouter's findUserById(userId) helper " +
    'directly (import it from the routes/user-router file) and rejects the request with 401 if none is found.',
};

function buildRetryTestSchema(): ValidatedProjectSchema {
  const compiled = compileBlueprint({
    text: 'backend/src/middleware must not import backend/src/routes',
    location: 'test-fixture',
    modules: [],
    directories: ['backend/src/middleware', 'backend/src/routes'],
  });
  const constraint = compiled.constraints[0];
  if (constraint === undefined) throw new Error('fixture constraint failed to compile');

  const candidate = {
    sessionId: 'retry-test',
    title: 'Retry test',
    originalPrompt: 'irrelevant for this fixture',
    domains: {
      frontend: { components: [], dependsOn: [] },
      backend: { components: [USER_ROUTER], dependsOn: [] },
      database: { components: [], dependsOn: [] },
      security: { components: [AUTH_MIDDLEWARE], dependsOn: [] },
    },
    constraints: [constraint],
    provenance: 'STATED' as const,
  };
  const validated = validateProjectSchema(candidate);
  if (!validated.ok) throw new Error(`fixture schema invalid: ${JSON.stringify(validated.error)}`);
  return validated.value;
}

const VIOLATING_MIDDLEWARE = [
  "import { findUserById } from '../routes/user-router';",
  'export default function authMiddleware(req, res, next) {',
  '  const user = findUserById(req.headers["x-user-id"]);',
  '  if (!user) return res.status(401).json({ error: "unauthorized" });',
  '  next();',
  '}',
].join('\n');

const COMPLIANT_MIDDLEWARE = [
  'export default function authMiddleware(req, res, next) {',
  '  const userId = req.headers["x-user-id"];',
  '  if (!userId) return res.status(401).json({ error: "unauthorized" });',
  '  next();',
  '}',
].join('\n');

const ROUTER_CODE = [
  'const users = [];',
  'export function findUserById(id) { return users.find((u) => u.id === id); }',
  "import { Router } from 'express';",
  'const router = Router();',
  "router.get('/:id', (req, res) => res.json(findUserById(req.params.id)));",
  'export default router;',
].join('\n');

describe('generateAndVerifyProject', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vibe-generate-verify-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('regenerates exactly the offending component once and fixes a real violation', async () => {
    const schema = buildRetryTestSchema();
    const provider = providerFrom((request) => {
      if (request.user.includes('Domain: backend')) return ROUTER_CODE;
      // security: violate on the first attempt, comply once corrective context appears.
      return request.user.includes('CORRECTION REQUIRED') ? COMPLIANT_MIDDLEWARE : VIOLATING_MIDDLEWARE;
    });

    const result = await generateAndVerifyProject(schema, { provider, cache: memoryCache(), root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.regenerationLog).toHaveLength(1);
    const attempt = result.value.regenerationLog[0];
    expect(attempt?.component.name).toBe('AuthMiddleware');
    expect(attempt?.domain).toBe('security');
    expect(attempt?.outcome).toBe('fixed');
    expect(attempt?.firstAttemptViolation.ruleText).toBe(
      'backend/src/middleware must not import backend/src/routes',
    );
    expect(attempt?.firstAttemptViolation.evidence[0]?.snippet).toContain('user-router');

    expect(result.value.unresolvedViolations).toEqual([]);

    // The regenerated file actually replaced the violating one in the returned files.
    const middlewareFile = result.value.files.find((f) => f.path === 'backend/src/middleware/auth-middleware.ts');
    expect(middlewareFile?.contents).toBe(`${COMPLIANT_MIDDLEWARE}\n`);

    // The retried prompt genuinely carried the real evidence, not a paraphrase.
    const correctionCall = provider.calls.find((c) => c.user.includes('CORRECTION REQUIRED'));
    expect(correctionCall?.user).toContain('backend/src/middleware must not import backend/src/routes');
    expect(correctionCall?.user).toContain("../routes/user-router");
  });

  it('reports every real phase in order when a retry is needed', async () => {
    const schema = buildRetryTestSchema();
    const provider = providerFrom((request) => {
      if (request.user.includes('Domain: backend')) return ROUTER_CODE;
      return request.user.includes('CORRECTION REQUIRED') ? COMPLIANT_MIDDLEWARE : VIOLATING_MIDDLEWARE;
    });
    const phases: string[] = [];

    const result = await generateAndVerifyProject(schema, {
      provider,
      cache: memoryCache(),
      root,
      onPhase: (phase) => phases.push(phase),
    });

    expect(result.ok).toBe(true);
    expect(phases).toEqual(['generating', 'verifying', 'regenerating', 'reverifying']);
  });

  it('stops after verifying when the first attempt already complies - no regenerating/reverifying phase', async () => {
    const schema = buildRetryTestSchema();
    const provider = providerFrom((request) => (request.user.includes('Domain: backend') ? ROUTER_CODE : COMPLIANT_MIDDLEWARE));
    const phases: string[] = [];

    const result = await generateAndVerifyProject(schema, {
      provider,
      cache: memoryCache(),
      root,
      onPhase: (phase) => phases.push(phase),
    });

    expect(result.ok).toBe(true);
    expect(phases).toEqual(['generating', 'verifying']);
  });

  it('hard-fails as a review item when the retry still violates, without a second retry', async () => {
    const schema = buildRetryTestSchema();
    const provider = providerFrom((request) => {
      if (request.user.includes('Domain: backend')) return ROUTER_CODE;
      // Always violates, even after correction - the model never learns.
      return VIOLATING_MIDDLEWARE;
    });

    const result = await generateAndVerifyProject(schema, { provider, cache: memoryCache(), root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.regenerationLog).toHaveLength(1);
    expect(result.value.regenerationLog[0]?.outcome).toBe('still-violating');
    expect(result.value.unresolvedViolations).toHaveLength(1);
    expect(result.value.unresolvedViolations[0]?.constraint.rawText).toBe(
      'backend/src/middleware must not import backend/src/routes',
    );

    // Only ever ONE retry: exactly two calls total for the security component
    // (first attempt + one correction), never three.
    const securityCalls = provider.calls.filter((c) => c.user.includes('Domain: security'));
    expect(securityCalls).toHaveLength(2);

    // The constraint itself is untouched - still present, still the same text.
    expect(schema.constraints[0]?.rawText).toBe('backend/src/middleware must not import backend/src/routes');
  });

  it('reports no regeneration at all when the first attempt already complies', async () => {
    const schema = buildRetryTestSchema();
    const provider = providerFrom((request) => (request.user.includes('Domain: backend') ? ROUTER_CODE : COMPLIANT_MIDDLEWARE));

    const result = await generateAndVerifyProject(schema, { provider, cache: memoryCache(), root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.regenerationLog).toEqual([]);
    expect(result.value.unresolvedViolations).toEqual([]);

    const securityCalls = provider.calls.filter((c) => c.user.includes('Domain: security'));
    expect(securityCalls).toHaveLength(1);
  });

  it('regenerates every independently-offending component when one constraint bundles edges from several files', async () => {
    // Reproduces the real scale-test finding: Blueprint's Violation.edges
    // can span several different files that all break the same constraint
    // (three separate routers each importing the database layer is ONE
    // Violation with three edges, not three Violations) - the retry loop
    // must attribute and fix each offending file independently, not just
    // the first edge.
    const LOGGING_MIDDLEWARE_VIOLATING = [
      "import { findUserById } from '../routes/user-router';",
      'export default function loggingMiddleware(req, res, next) {',
      '  console.log(findUserById(req.headers["x-user-id"]));',
      '  next();',
      '}',
    ].join('\n');
    const LOGGING_MIDDLEWARE_COMPLIANT = [
      'export default function loggingMiddleware(req, res, next) {',
      '  console.log(req.headers["x-user-id"]);',
      '  next();',
      '}',
    ].join('\n');

    const loggingMiddleware: Component = {
      id: componentId('security', 'LoggingMiddleware', 'logging-middleware'),
      name: 'LoggingMiddleware',
      purpose: "Logs the requester's user record, found via the UserRouter's findUserById helper (import it from the routes/user-router file).",
    };

    const compiled = compileBlueprint({
      text: 'backend/src/middleware must not import backend/src/routes',
      location: 'test-fixture',
      modules: [],
      directories: ['backend/src/middleware', 'backend/src/routes'],
    });
    const constraint = compiled.constraints[0];
    if (constraint === undefined) throw new Error('fixture constraint failed to compile');

    const candidate = {
      sessionId: 'multi-file-retry-test',
      title: 'Multi-file retry test',
      originalPrompt: 'irrelevant for this fixture',
      domains: {
        frontend: { components: [], dependsOn: [] },
        backend: { components: [USER_ROUTER], dependsOn: [] },
        database: { components: [], dependsOn: [] },
        security: { components: [AUTH_MIDDLEWARE, loggingMiddleware], dependsOn: [] },
      },
      constraints: [constraint],
      provenance: 'STATED' as const,
    };
    const validated = validateProjectSchema(candidate);
    if (!validated.ok) throw new Error(`fixture schema invalid: ${JSON.stringify(validated.error)}`);
    const schema = validated.value;

    const provider = providerFrom((request) => {
      if (request.user.includes('Domain: backend')) return ROUTER_CODE;
      const corrected = request.user.includes('CORRECTION REQUIRED');
      if (request.user.includes('Component: AuthMiddleware')) return corrected ? COMPLIANT_MIDDLEWARE : VIOLATING_MIDDLEWARE;
      return corrected ? LOGGING_MIDDLEWARE_COMPLIANT : LOGGING_MIDDLEWARE_VIOLATING;
    });

    const result = await generateAndVerifyProject(schema, { provider, cache: memoryCache(), root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Both offending components were attributed and retried independently -
    // not just the first one Blueprint's merged Violation happened to list.
    expect(result.value.regenerationLog).toHaveLength(2);
    const byName = new Map(result.value.regenerationLog.map((a) => [a.component.name, a]));
    expect(byName.get('AuthMiddleware')?.outcome).toBe('fixed');
    expect(byName.get('LoggingMiddleware')?.outcome).toBe('fixed');
    expect(result.value.unresolvedViolations).toEqual([]);

    // Each component's corrective context carried only ITS OWN evidence line,
    // never the sibling component's - the cross-contamination the fix removed.
    const authCorrection = provider.calls.find((c) => c.user.includes('Component: AuthMiddleware') && c.user.includes('CORRECTION REQUIRED'));
    expect(authCorrection?.user).toContain('backend/src/middleware/auth-middleware.ts');
    expect(authCorrection?.user).not.toContain('logging-middleware.ts');

    const loggingCorrection = provider.calls.find((c) => c.user.includes('Component: LoggingMiddleware') && c.user.includes('CORRECTION REQUIRED'));
    expect(loggingCorrection?.user).toContain('backend/src/middleware/logging-middleware.ts');
    expect(loggingCorrection?.user).not.toContain('auth-middleware.ts');

    const authFile = result.value.files.find((f) => f.path === 'backend/src/middleware/auth-middleware.ts');
    const loggingFile = result.value.files.find((f) => f.path === 'backend/src/middleware/logging-middleware.ts');
    expect(authFile?.contents).toBe(`${COMPLIANT_MIDDLEWARE}\n`);
    expect(loggingFile?.contents).toBe(`${LOGGING_MIDDLEWARE_COMPLIANT}\n`);
  });

  describe('Item 3: suspected service-locator evasion', () => {
    const LOCATOR_EVASION_MIDDLEWARE = [
      'export default function authMiddleware(req, res, next) {',
      "  const findUserById = req.app.get('findUserById');",
      "  if (typeof findUserById === 'function' && findUserById(req.headers['x-user-id'])) {",
      '    next();',
      '    return;',
      '  }',
      '  res.status(401).json({ error: "unauthorized" });',
      '}',
    ].join('\n');

    it('retries a component that creates no import violation but exhibits the auth-bypass pattern on its FIRST attempt', async () => {
      const schema = buildRetryTestSchema();
      const provider = providerFrom((request) => {
        if (request.user.includes('Domain: backend')) return ROUTER_CODE;
        // No import at all on the first attempt (Blueprint sees nothing
        // wrong), but the runtime locator call is the exact pattern to catch.
        return request.user.includes('CORRECTION REQUIRED') ? COMPLIANT_MIDDLEWARE : LOCATOR_EVASION_MIDDLEWARE;
      });

      const result = await generateAndVerifyProject(schema, { provider, cache: memoryCache(), root });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Blueprint itself found nothing - no static import edge exists.
      expect(result.value.unresolvedViolations).toEqual([]);
      // But the service-locator check caught it and triggered exactly one retry.
      expect(result.value.regenerationLog).toHaveLength(1);
      const attempt = result.value.regenerationLog[0];
      expect(attempt?.origin).toBe('service-locator-evasion');
      expect(attempt?.outcome).toBe('fixed');
      expect(attempt?.firstAttemptViolation.ruleText).toBe(
        'backend/src/middleware must not import backend/src/routes',
      );
      expect(attempt?.firstAttemptViolation.evidence[0]?.snippet).toContain("req.app.get('findUserById')");
      expect(result.value.unresolvedServiceLocatorFindings).toEqual([]);
    });

    it('hard-fails as a review item, separate from unresolvedViolations, when the retry keeps the locator workaround', async () => {
      const schema = buildRetryTestSchema();
      const provider = providerFrom((request) => {
        if (request.user.includes('Domain: backend')) return ROUTER_CODE;
        // Never removes the locator call, even after correction.
        return LOCATOR_EVASION_MIDDLEWARE;
      });

      const result = await generateAndVerifyProject(schema, { provider, cache: memoryCache(), root });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.unresolvedViolations).toEqual([]);
      expect(result.value.regenerationLog).toHaveLength(1);
      expect(result.value.regenerationLog[0]?.origin).toBe('service-locator-evasion');
      expect(result.value.regenerationLog[0]?.outcome).toBe('still-violating');

      expect(result.value.unresolvedServiceLocatorFindings).toHaveLength(1);
      expect(result.value.unresolvedServiceLocatorFindings[0]?.lookupKey).toBe('findUserById');
      expect(result.value.unresolvedServiceLocatorFindings[0]?.matchedExportFile).toBe(
        'backend/src/routes/user-router.ts',
      );

      // Never two retries.
      const securityCalls = provider.calls.filter((c) => c.user.includes('Domain: security'));
      expect(securityCalls).toHaveLength(2);
    });

    it(
      'catches the real regression this check exists for: a Blueprint-violation retry that "fixes" the ' +
        'import but swaps in the exact service-locator evasion (docs/GENERATION.md\'s own live finding)',
      async () => {
        const schema = buildRetryTestSchema();
        const provider = providerFrom((request) => {
          if (request.user.includes('Domain: backend')) return ROUTER_CODE;
          // First attempt: a real, static import violation (Blueprint-origin
          // retry fires). "Corrected" attempt: no import edge, but the exact
          // real-world workaround from the live Milestone 3 finding.
          return request.user.includes('CORRECTION REQUIRED') ? LOCATOR_EVASION_MIDDLEWARE : VIOLATING_MIDDLEWARE;
        });

        const result = await generateAndVerifyProject(schema, { provider, cache: memoryCache(), root });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        // Blueprint's own second check reports this file clean - no import
        // edge exists in the "corrected" version. Without Item 3, this would
        // have been reported 'fixed'.
        expect(result.value.unresolvedViolations).toEqual([]);

        expect(result.value.regenerationLog).toHaveLength(1);
        const attempt = result.value.regenerationLog[0];
        // The retry that fired was Blueprint-triggered (a real import existed
        // on the first attempt) - origin reflects what actually triggered it.
        expect(attempt?.origin).toBe('blueprint-violation');
        // But the outcome is correctly 'still-violating', not 'fixed', because
        // the service-locator check catches what Blueprint's second pass
        // cannot see.
        expect(attempt?.outcome).toBe('still-violating');

        expect(result.value.unresolvedServiceLocatorFindings).toHaveLength(1);
        expect(result.value.unresolvedServiceLocatorFindings[0]?.file).toBe(
          'backend/src/middleware/auth-middleware.ts',
        );
      },
    );
  });
});
