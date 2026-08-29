import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateProjectSchema } from './validate-project-schema.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/project-schema/', import.meta.url));

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}${name}`, 'utf-8'));
}

describe('validateProjectSchema', () => {
  it('accepts the todo-app fixture', () => {
    const result = validateProjectSchema(loadFixture('todo-app.json'));
    expect(result.ok).toBe(true);
  });

  it('accepts the blog-with-auth fixture', () => {
    const result = validateProjectSchema(loadFixture('blog-with-auth.json'));
    expect(result.ok).toBe(true);
  });

  it('accepts the habit-tracker fixture, including an empty security domain', () => {
    const result = validateProjectSchema(loadFixture('habit-tracker.json'));
    expect(result.ok).toBe(true);
  });

  it('rejects a non-object candidate', () => {
    const result = validateProjectSchema('not an object');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual([{ path: '$', reason: 'not-an-object' }]);
    }
  });

  it('rejects the invalid fixture with every violation, not just the first', () => {
    const result = validateProjectSchema(loadFixture('invalid-duplicate-component-id.json'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const reasons = result.error.map((rejection) => rejection.reason);
      expect(reasons).toContain('duplicate-component-id');
      expect(reasons).toContain('unknown-domain-dependency');
      expect(reasons).toContain('invalid-constraint-relation');
      expect(reasons).toContain('wrong-provenance-literal');
      // More than one problem must be reported in a single pass.
      expect(result.error.length).toBeGreaterThan(1);
    }
  });

  it('rejects a schema missing required top-level fields', () => {
    const result = validateProjectSchema({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.error.map((rejection) => rejection.path);
      expect(paths).toContain('$.sessionId');
      expect(paths).toContain('$.title');
      expect(paths).toContain('$.originalPrompt');
      expect(paths).toContain('$.domains');
      expect(paths).toContain('$.constraints');
      expect(paths).toContain('$.provenance');
    }
  });

  it('rejects a key on candidate.domains that is not one of the 4 canonical DOMAIN_NAMES', () => {
    const schema = validSchema();
    // Add a 5th key alongside the 4 required ones - plain object mutation,
    // not a type-level cast, matching how this would actually arrive from
    // JSON.parse(modelOutput) with no compile-time barrier in the way.
    (schema.domains as Record<string, unknown>)['Database'] = { components: [], dependsOn: [] };

    const result = validateProjectSchema(schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const rejection = result.error.find((r) => r.reason === 'unrecognized-domain-key');
      expect(rejection).toBeDefined();
      expect(rejection).toEqual({ path: '$.domains.Database', reason: 'unrecognized-domain-key', value: 'Database' });
      // Distinct from unknown-domain-dependency, which is a bad value
      // inside a dependsOn array, not a bad key on domains itself.
      expect(result.error.some((r) => r.reason === 'unknown-domain-dependency')).toBe(false);
    }
  });

  it('rejects a domain that names itself in its own dependsOn', () => {
    const schema = validSchema();
    schema.domains.frontend.dependsOn = ['frontend'];

    const result = validateProjectSchema(schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContainEqual({
        path: '$.domains.frontend.dependsOn[0]',
        reason: 'self-referential-domain-dependency',
      });
      // Not also reported as unknown-domain-dependency - 'frontend' is a
      // real domain name, just the wrong one to appear in its own list.
      expect(result.error.some((r) => r.reason === 'unknown-domain-dependency')).toBe(false);
    }
  });

  it('regression: case-variant domain keys (database and Database both present) are now rejected, not silently accepted', () => {
    // The exact scenario empirically confirmed to pass validateProjectSchema
    // earlier this session: schema.domains carrying both the canonical
    // lowercase 'database' key and an extra 'Database' key side by side.
    const schema = validSchema();
    (schema.domains as Record<string, unknown>)['Database'] = { components: [], dependsOn: ['frontend'] };

    const result = validateProjectSchema(schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContainEqual({ path: '$.domains.Database', reason: 'unrecognized-domain-key', value: 'Database' });
    }
  });

  it('regression: a real Gemini response with status: null, origin: null, and source.line/timestamp as empty objects is now rejected, not silently accepted', () => {
    // The exact malformed shape a real Gemini generation returned today
    // (see the recipe-manager live-call run). validateConstraint used to
    // check subject/object/source only with isRecord() - this candidate
    // passed validateProjectSchema (ok: true) despite none of these values
    // being valid: status/origin should be the literal 'UNRESOLVED'/'prose'
    // UNRESOLVED_PROSE_SUBJECT_SCHEMA requires, and source.line/timestamp
    // should be number|null / string|null, not {}.
    const schema = validSchema();
    (schema.constraints as unknown[]) = [
      {
        id: 'constraint-frontend-must-not-bypass-backend',
        relation: 'may-only-import-via',
        subject: {
          phrase: 'frontend',
          status: null,
          target: null,
          origin: null,
          reason: null,
          similarity: 0,
          alternatives: [],
        },
        object: {
          phrase: 'database',
          status: null,
          target: null,
          origin: null,
          reason: null,
          similarity: 0,
          alternatives: [],
        },
        via: {
          phrase: 'backend',
          status: null,
          target: null,
          origin: null,
          reason: null,
          similarity: 0,
          alternatives: [],
        },
        source: {
          type: 'user-authored',
          location: 'prompt',
          line: {},
          timestamp: {},
        },
        confidence: 1,
        lowConfidence: false,
        rawText: 'Frontend must interact with the database only through the backend API.',
        provenance: 'STATED',
      },
    ];

    const result = validateProjectSchema(schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const reasons = result.error.map((r) => r.reason);
      // status: null is invalid on all three (subject, object, via).
      expect(result.error).toContainEqual({
        path: '$.constraints[0].subject.status',
        reason: 'invalid-resolved-subject',
        detail: expect.stringContaining('status must be one of'),
      });
      expect(result.error).toContainEqual({
        path: '$.constraints[0].object.status',
        reason: 'invalid-resolved-subject',
        detail: expect.stringContaining('status must be one of'),
      });
      expect(result.error).toContainEqual({
        path: '$.constraints[0].via.status',
        reason: 'invalid-resolved-subject',
        detail: expect.stringContaining('status must be one of'),
      });
      // source.line / source.timestamp: {} are neither number|null nor string|null.
      expect(result.error).toContainEqual({
        path: '$.constraints[0].source.line',
        reason: 'missing-or-wrong-type',
        expected: 'number or null',
      });
      expect(result.error).toContainEqual({
        path: '$.constraints[0].source.timestamp',
        reason: 'missing-or-wrong-type',
        expected: 'string or null',
      });
      expect(reasons.filter((r) => r === 'invalid-resolved-subject').length).toBeGreaterThanOrEqual(3);
    }
  });

  it('accepts a well-formed resolved (non-UNRESOLVED) subject, not just UNRESOLVED', () => {
    // The field-level checks must not over-narrow to only the
    // generation-time UNRESOLVED shape - a real MODULE-resolved subject
    // (from actual intent extraction against real code) is equally valid.
    const schema = validSchema();
    (schema.constraints as unknown[]) = [
      {
        id: 'constraint-1',
        relation: 'must-not-import',
        subject: {
          phrase: 'the api layer',
          status: 'MODULE',
          target: 'src/api/index.ts',
          origin: 'prose',
          reason: null,
          similarity: 0.92,
          alternatives: [],
        },
        object: {
          phrase: 'the database',
          status: 'UNRESOLVED',
          target: null,
          origin: 'prose',
          reason: 'no-candidate',
          similarity: 0,
          alternatives: [],
        },
        via: null,
        source: { type: 'readme', location: 'README.md', line: 12, timestamp: null },
        confidence: 0.8,
        lowConfidence: false,
        rawText: 'The API layer must never import the database directly.',
        provenance: 'STATED',
      },
    ];

    const result = validateProjectSchema(schema);

    expect(result.ok).toBe(true);
  });

  it('regression: a via missing phrase/similarity/alternatives entirely is now rejected, not silently accepted', () => {
    // The exact shape a real Gemini generation returned today for via -
    // status/target/origin/reason present and correct, but phrase,
    // similarity, and alternatives entirely absent. validateResolvedSubject
    // only checked status/target/reason/origin - this candidate passed
    // validateProjectSchema (ok: true) despite three required fields never
    // being present at all.
    const schema = validSchema();
    (schema.constraints as unknown[]) = [
      {
        id: 'frontend-must-not-bypass-backend',
        relation: 'must-not-import',
        subject: {
          phrase: 'frontend',
          status: 'UNRESOLVED',
          target: null,
          origin: 'prose',
          reason: 'no-candidate',
          similarity: 0,
          alternatives: [],
        },
        object: {
          phrase: 'database',
          status: 'UNRESOLVED',
          target: null,
          origin: 'prose',
          reason: 'no-candidate',
          similarity: 0,
          alternatives: [],
        },
        // Exactly today's real malformed via - no phrase, no similarity,
        // no alternatives.
        via: {
          status: 'UNRESOLVED',
          target: null,
          origin: 'prose',
          reason: 'no-candidate',
        },
        source: {
          type: 'user-authored',
          location: 'implied-architecture',
          line: null,
          timestamp: '2026-08-29T14:31:58.273Z',
        },
        confidence: 1,
        lowConfidence: false,
        rawText: 'The frontend must not access the database directly; it must go through the backend service.',
        provenance: 'STATED',
      },
    ];

    const result = validateProjectSchema(schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContainEqual({
        path: '$.constraints[0].via.phrase',
        reason: 'missing-or-wrong-type',
        expected: 'non-empty string',
      });
      expect(result.error).toContainEqual({
        path: '$.constraints[0].via.similarity',
        reason: 'missing-or-wrong-type',
        expected: 'number',
      });
      expect(result.error).toContainEqual({
        path: '$.constraints[0].via.alternatives',
        reason: 'missing-or-wrong-type',
        expected: 'array of strings',
      });
      // subject and object are unaffected - only via was malformed.
      expect(result.error.some((r) => r.path.startsWith('$.constraints[0].subject.'))).toBe(false);
      expect(result.error.some((r) => r.path.startsWith('$.constraints[0].object.'))).toBe(false);
    }
  });
});

function validSchema(): {
  sessionId: string;
  title: string;
  originalPrompt: string;
  domains: {
    frontend: { components: unknown[]; dependsOn: string[] };
    backend: { components: unknown[]; dependsOn: string[] };
    database: { components: unknown[]; dependsOn: string[] };
    security: { components: unknown[]; dependsOn: string[] };
  };
  constraints: unknown[];
  provenance: 'STATED';
} {
  return {
    sessionId: 'session-test',
    title: 'Test Schema',
    originalPrompt: 'irrelevant for this fixture',
    domains: {
      frontend: { components: [], dependsOn: [] },
      backend: { components: [], dependsOn: [] },
      database: { components: [], dependsOn: [] },
      security: { components: [], dependsOn: [] },
    },
    constraints: [],
    provenance: 'STATED',
  };
}
