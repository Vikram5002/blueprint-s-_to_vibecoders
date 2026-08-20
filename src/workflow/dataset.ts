/**
 * Structural validation and near-duplicate detection for fine-tuning dataset
 * pairs (natural-language project description -> ProjectSchema).
 *
 * A dataset pair's schema is validated with the real `validateProjectSchema`,
 * not a parallel check — the same rule as ProjectSchema itself reusing
 * `Constraint`: there is exactly one definition of "valid", and everything
 * that checks validity goes through it.
 *
 * Rejection is loud by design, same posture as validate-project-schema.ts:
 * a pair that fails validation is reported with a specific reason, never
 * silently dropped and never silently kept. See training/data/METHODOLOGY.md
 * for how this fits into the three-source dataset plan.
 */

import { type Result, ok, err } from '../types/result.js';
import { validateProjectSchema, type ProjectSchemaRejection } from './validate-project-schema.js';

export const DATASET_SOURCES = ['hand-written', 'real-project', 'synthetic'] as const;
export type DatasetSource = (typeof DATASET_SOURCES)[number];

export interface DatasetPair {
  readonly prompt: string;
  readonly schema: unknown;
  readonly source: DatasetSource;
  readonly sourceUrl?: string;
}

export type DatasetPairRejection =
  | { readonly path: string; readonly reason: 'not-an-object' }
  | { readonly path: string; readonly reason: 'missing-or-wrong-type'; readonly expected: string }
  | { readonly path: string; readonly reason: 'empty-string' }
  | { readonly path: string; readonly reason: 'invalid-source'; readonly value: unknown }
  | { readonly path: string; readonly reason: 'invalid-schema'; readonly errors: readonly ProjectSchemaRejection[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates one dataset line: the pair envelope (prompt/source/sourceUrl)
 * plus the schema itself via the real validateProjectSchema. Reports every
 * problem found, not just the first, matching validateProjectSchema's own
 * posture.
 */
export function validateDatasetPair(candidate: unknown): Result<DatasetPair, readonly DatasetPairRejection[]> {
  if (!isRecord(candidate)) {
    return err([{ path: '$', reason: 'not-an-object' }]);
  }

  const rejections: DatasetPairRejection[] = [];

  if (typeof candidate['prompt'] !== 'string') {
    rejections.push({ path: '$.prompt', reason: 'missing-or-wrong-type', expected: 'string' });
  } else if (candidate['prompt'].trim().length === 0) {
    rejections.push({ path: '$.prompt', reason: 'empty-string' });
  }

  if (!(DATASET_SOURCES as readonly unknown[]).includes(candidate['source'])) {
    rejections.push({ path: '$.source', reason: 'invalid-source', value: candidate['source'] });
  }

  if ('sourceUrl' in candidate && candidate['sourceUrl'] !== undefined && typeof candidate['sourceUrl'] !== 'string') {
    rejections.push({ path: '$.sourceUrl', reason: 'missing-or-wrong-type', expected: 'string' });
  }

  const schemaResult = validateProjectSchema(candidate['schema']);
  if (!schemaResult.ok) {
    rejections.push({ path: '$.schema', reason: 'invalid-schema', errors: schemaResult.error });
  }

  if (rejections.length > 0) {
    return err(rejections);
  }

  return ok(candidate as unknown as DatasetPair);
}

/** Lowercased, punctuation stripped, whitespace collapsed — for comparison only. */
export function normalizePrompt(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .join(' ');
}

/** Jaccard similarity of the two prompts' word sets, after normalizePrompt. 0-1. */
export function promptSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalizePrompt(a).split(' ').filter(Boolean));
  const wordsB = new Set(normalizePrompt(b).split(' ').filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) {
    return 1;
  }
  let intersectionSize = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) {
      intersectionSize += 1;
    }
  }
  const unionSize = wordsA.size + wordsB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

export interface NearDuplicatePair {
  readonly indexA: number;
  readonly indexB: number;
  readonly similarity: number;
}

/**
 * Flags every pair of prompts at or above `threshold` Jaccard similarity.
 * O(n^2) — deliberately simple for a dataset in the hundreds, not thousands,
 * of pairs; see METHODOLOGY.md's target split.
 */
export function findNearDuplicatePrompts(
  prompts: readonly string[],
  threshold = 0.8,
): readonly NearDuplicatePair[] {
  const found: NearDuplicatePair[] = [];
  for (let i = 0; i < prompts.length; i += 1) {
    for (let j = i + 1; j < prompts.length; j += 1) {
      const promptA = prompts[i];
      const promptB = prompts[j];
      if (promptA === undefined || promptB === undefined) {
        continue;
      }
      const similarity = promptSimilarity(promptA, promptB);
      if (similarity >= threshold) {
        found.push({ indexA: i, indexB: j, similarity });
      }
    }
  }
  return found;
}
