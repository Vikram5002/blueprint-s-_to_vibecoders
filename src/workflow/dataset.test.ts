import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findNearDuplicatePrompts,
  normalizePrompt,
  promptSimilarity,
  validateDatasetPair,
} from './dataset.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/project-schema/', import.meta.url));

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}${name}`, 'utf-8'));
}

describe('validateDatasetPair', () => {
  it('accepts a well-formed pair wrapping a valid ProjectSchema', () => {
    const result = validateDatasetPair({
      prompt: 'A todo app.',
      schema: loadFixture('todo-app.json'),
      source: 'hand-written',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an empty prompt', () => {
    const result = validateDatasetPair({
      prompt: '   ',
      schema: loadFixture('todo-app.json'),
      source: 'hand-written',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.some((r) => r.path === '$.prompt' && r.reason === 'empty-string')).toBe(true);
    }
  });

  it('rejects an invalid source value', () => {
    const result = validateDatasetPair({
      prompt: 'A todo app.',
      schema: loadFixture('todo-app.json'),
      source: 'made-up-source',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.some((r) => r.path === '$.source' && r.reason === 'invalid-source')).toBe(true);
    }
  });

  it('rejects a pair whose schema is invalid, surfacing the underlying reasons', () => {
    const result = validateDatasetPair({
      prompt: 'A todo app.',
      schema: loadFixture('invalid-duplicate-component-id.json'),
      source: 'hand-written',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const schemaRejection = result.error.find((r) => r.path === '$.schema');
      expect(schemaRejection?.reason).toBe('invalid-schema');
    }
  });
});

describe('normalizePrompt', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizePrompt('  Build a TODO-app!!  now.  ')).toBe('build a todo app now');
  });
});

describe('promptSimilarity', () => {
  it('is 1 for identical prompts', () => {
    expect(promptSimilarity('A todo app for teams.', 'A todo app for teams.')).toBe(1);
  });

  it('is high for near-identical prompts differing only in punctuation/case', () => {
    expect(promptSimilarity('Build a todo app.', 'build a TODO app')).toBeGreaterThan(0.9);
  });

  it('is low for unrelated prompts', () => {
    expect(promptSimilarity('A weather app.', 'A HIPAA-compliant patient records portal.')).toBeLessThan(0.3);
  });
});

describe('findNearDuplicatePrompts', () => {
  it('flags a near-identical pair and leaves distinct prompts alone', () => {
    const prompts = ['Build a todo app for teams.', 'Build a todo app for teams!', 'A weather app.'];
    const duplicates = findNearDuplicatePrompts(prompts);
    expect(duplicates).toEqual([{ indexA: 0, indexB: 1, similarity: 1 }]);
  });

  it('returns nothing when no prompts are near-duplicates', () => {
    const prompts = ['A weather app.', 'A recipe sharing site.', 'An IoT sensor dashboard.'];
    expect(findNearDuplicatePrompts(prompts)).toEqual([]);
  });
});
