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
});
