/**
 * Structural validation of a candidate ProjectSchema.
 *
 * This is the gate a fine-tuned model's output has to pass before it is
 * treated as a real ProjectSchema anywhere downstream — training-data
 * curation, generation-time checking, or eventually promoting a schema's
 * constraints into a real Type-1 blueprint. Same posture as
 * src/llm/validate.ts: rejection is cheap and there is no fallback to fall
 * back to, so every check is strict and every rejection carries a specific,
 * reportable reason rather than a generic "invalid".
 *
 * Constraint validation is deliberately structural, not semantic: this module
 * checks that each constraint has the shape Constraint requires (relation is
 * one of the four, provenance is the STATED literal, source/subject/object
 * are present), not whether the constraint is *true* of any real code — there
 * is no code yet for a ProjectSchema's constraints to be true or false of.
 */

import { type Result, ok, err } from '../types/result.js';
import { CONSTRAINT_RELATIONS } from '../types/constraints.js';
import { DOMAIN_NAMES, type ProjectSchema } from '../types/project-schema.js';

export type ProjectSchemaRejection =
  | { readonly path: string; readonly reason: 'not-an-object' }
  | { readonly path: string; readonly reason: 'missing-or-wrong-type'; readonly expected: string }
  | { readonly path: string; readonly reason: 'empty-string' }
  | { readonly path: string; readonly reason: 'unknown-domain-dependency'; readonly value: string }
  | { readonly path: string; readonly reason: 'self-referential-domain-dependency' }
  | { readonly path: string; readonly reason: 'duplicate-component-id'; readonly value: string }
  | { readonly path: string; readonly reason: 'invalid-constraint-relation'; readonly value: unknown }
  | { readonly path: string; readonly reason: 'wrong-provenance-literal'; readonly value: unknown };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateComponent(
  candidate: unknown,
  path: string,
  seenIds: Set<string>,
): readonly ProjectSchemaRejection[] {
  if (!isRecord(candidate)) {
    return [{ path, reason: 'not-an-object' }];
  }
  const rejections: ProjectSchemaRejection[] = [];
  for (const field of ['id', 'name', 'purpose'] as const) {
    if (!isNonEmptyString(candidate[field])) {
      rejections.push({ path: `${path}.${field}`, reason: 'missing-or-wrong-type', expected: 'non-empty string' });
    }
  }
  if (typeof candidate['id'] === 'string') {
    if (seenIds.has(candidate['id'])) {
      rejections.push({ path: `${path}.id`, reason: 'duplicate-component-id', value: candidate['id'] });
    }
    seenIds.add(candidate['id']);
  }
  return rejections;
}

function validateDomainSpec(candidate: unknown, path: string, seenIds: Set<string>): readonly ProjectSchemaRejection[] {
  if (!isRecord(candidate)) {
    return [{ path, reason: 'not-an-object' }];
  }
  const rejections: ProjectSchemaRejection[] = [];

  if (!Array.isArray(candidate['components'])) {
    rejections.push({ path: `${path}.components`, reason: 'missing-or-wrong-type', expected: 'array' });
  } else {
    candidate['components'].forEach((component, index) => {
      rejections.push(...validateComponent(component, `${path}.components[${index}]`, seenIds));
    });
  }

  if (!Array.isArray(candidate['dependsOn'])) {
    rejections.push({ path: `${path}.dependsOn`, reason: 'missing-or-wrong-type', expected: 'array' });
  } else {
    candidate['dependsOn'].forEach((dep, index) => {
      if (!(DOMAIN_NAMES as readonly unknown[]).includes(dep)) {
        rejections.push({ path: `${path}.dependsOn[${index}]`, reason: 'unknown-domain-dependency', value: String(dep) });
      }
    });
  }

  return rejections;
}

function validateConstraint(candidate: unknown, path: string): readonly ProjectSchemaRejection[] {
  if (!isRecord(candidate)) {
    return [{ path, reason: 'not-an-object' }];
  }
  const rejections: ProjectSchemaRejection[] = [];

  if (!(CONSTRAINT_RELATIONS as readonly unknown[]).includes(candidate['relation'])) {
    rejections.push({ path: `${path}.relation`, reason: 'invalid-constraint-relation', value: candidate['relation'] });
  }
  if (candidate['provenance'] !== 'STATED') {
    rejections.push({ path: `${path}.provenance`, reason: 'wrong-provenance-literal', value: candidate['provenance'] });
  }
  for (const field of ['id', 'rawText'] as const) {
    if (!isNonEmptyString(candidate[field])) {
      rejections.push({ path: `${path}.${field}`, reason: 'missing-or-wrong-type', expected: 'non-empty string' });
    }
  }
  for (const field of ['subject', 'object', 'source'] as const) {
    if (!isRecord(candidate[field])) {
      rejections.push({ path: `${path}.${field}`, reason: 'missing-or-wrong-type', expected: 'object' });
    }
  }

  return rejections;
}

/**
 * Validates a candidate against the ProjectSchema shape and returns every
 * violation found, not just the first — a dataset curation pass needs to see
 * everything wrong with a rejected pair in one report, not one error at a
 * time across repeated runs.
 */
export function validateProjectSchema(candidate: unknown): Result<ProjectSchema, readonly ProjectSchemaRejection[]> {
  const rejections: ProjectSchemaRejection[] = [];

  if (!isRecord(candidate)) {
    return err([{ path: '$', reason: 'not-an-object' }]);
  }

  for (const field of ['sessionId', 'title', 'originalPrompt'] as const) {
    if (!isNonEmptyString(candidate[field])) {
      rejections.push({ path: `$.${field}`, reason: 'missing-or-wrong-type', expected: 'non-empty string' });
    }
  }

  if (candidate['provenance'] !== 'STATED') {
    rejections.push({ path: '$.provenance', reason: 'wrong-provenance-literal', value: candidate['provenance'] });
  }

  const seenComponentIds = new Set<string>();
  if (!isRecord(candidate['domains'])) {
    rejections.push({ path: '$.domains', reason: 'missing-or-wrong-type', expected: 'object' });
  } else {
    const domains = candidate['domains'];
    for (const domainName of DOMAIN_NAMES) {
      rejections.push(...validateDomainSpec(domains[domainName], `$.domains.${domainName}`, seenComponentIds));
    }
  }

  if (!Array.isArray(candidate['constraints'])) {
    rejections.push({ path: '$.constraints', reason: 'missing-or-wrong-type', expected: 'array' });
  } else {
    candidate['constraints'].forEach((constraint, index) => {
      rejections.push(...validateConstraint(constraint, `$.constraints[${index}]`));
    });
  }

  if (rejections.length > 0) {
    return err(rejections);
  }

  return ok(candidate as unknown as ProjectSchema);
}
