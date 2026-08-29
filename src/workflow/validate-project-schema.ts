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
import {
  CONSTRAINT_RELATIONS,
  SUBJECT_RESOLUTION_STATUSES,
  SUBJECT_UNRESOLVED_REASONS,
} from '../types/constraints.js';
import { DOMAIN_NAMES, type DomainName, type ProjectSchema } from '../types/project-schema.js';

export type ProjectSchemaRejection =
  | { readonly path: string; readonly reason: 'not-an-object' }
  | { readonly path: string; readonly reason: 'missing-or-wrong-type'; readonly expected: string }
  | { readonly path: string; readonly reason: 'empty-string' }
  | { readonly path: string; readonly reason: 'unknown-domain-dependency'; readonly value: string }
  | { readonly path: string; readonly reason: 'unrecognized-domain-key'; readonly value: string }
  | { readonly path: string; readonly reason: 'self-referential-domain-dependency' }
  | { readonly path: string; readonly reason: 'duplicate-component-id'; readonly value: string }
  | { readonly path: string; readonly reason: 'invalid-constraint-relation'; readonly value: unknown }
  | { readonly path: string; readonly reason: 'wrong-provenance-literal'; readonly value: unknown }
  /**
   * A ResolvedSubject's status/target/reason/origin combination doesn't
   * hold together - status isn't one of the four real values, or it is
   * but target/reason don't match what that status requires (e.g.
   * UNRESOLVED with a non-null target, or a resolved status with a
   * non-null reason), or origin is present but isn't 'prose'/'regex'.
   * `detail` carries which specific check failed and what was found,
   * since this single reason covers several distinct field-consistency
   * problems within one ResolvedSubject.
   */
  | { readonly path: string; readonly reason: 'invalid-resolved-subject'; readonly detail: string };

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

function validateDomainSpec(
  candidate: unknown,
  domainName: DomainName,
  path: string,
  seenIds: Set<string>,
): readonly ProjectSchemaRejection[] {
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
        return;
      }
      if (dep === domainName) {
        rejections.push({ path: `${path}.dependsOn[${index}]`, reason: 'self-referential-domain-dependency' });
      }
    });
  }

  return rejections;
}

/**
 * Field-level validation of a ResolvedSubject (Constraint.subject,
 * .object, and non-null .via all share this shape).
 *
 * Previously this was checked only with isRecord() - confirming subject
 * was *an* object, never that its fields held together. A real Gemini
 * response returned status: null and origin: null here (should be the
 * literal 'UNRESOLVED' and 'prose' UNRESOLVED_PROSE_SUBJECT_SCHEMA
 * requires) and validateProjectSchema accepted it anyway - this closes
 * that gap.
 */
function validateResolvedSubject(candidate: unknown, path: string): readonly ProjectSchemaRejection[] {
  if (!isRecord(candidate)) {
    return [{ path, reason: 'not-an-object' }];
  }
  const rejections: ProjectSchemaRejection[] = [];

  const status = candidate['status'];
  if (!(SUBJECT_RESOLUTION_STATUSES as readonly unknown[]).includes(status)) {
    rejections.push({
      path: `${path}.status`,
      reason: 'invalid-resolved-subject',
      detail: `status must be one of ${SUBJECT_RESOLUTION_STATUSES.join(', ')}, got ${JSON.stringify(status)}`,
    });
  } else if (status === 'UNRESOLVED') {
    // Could not be mapped: target names nothing, reason says why.
    if (candidate['target'] !== null) {
      rejections.push({
        path: `${path}.target`,
        reason: 'invalid-resolved-subject',
        detail: `target must be null when status is UNRESOLVED, got ${JSON.stringify(candidate['target'])}`,
      });
    }
    if (!(SUBJECT_UNRESOLVED_REASONS as readonly unknown[]).includes(candidate['reason'])) {
      rejections.push({
        path: `${path}.reason`,
        reason: 'invalid-resolved-subject',
        detail:
          `reason must be one of ${SUBJECT_UNRESOLVED_REASONS.join(', ')} when status is UNRESOLVED, ` +
          `got ${JSON.stringify(candidate['reason'])}`,
      });
    }
  } else {
    // MODULE / PATH_PATTERN / REGEX_PATTERN: resolved, so target names
    // what it resolved to and there is no unresolved-reason to give.
    if (!isNonEmptyString(candidate['target'])) {
      rejections.push({
        path: `${path}.target`,
        reason: 'invalid-resolved-subject',
        detail: `target must be a non-empty string when status is ${String(status)}, got ${JSON.stringify(candidate['target'])}`,
      });
    }
    if (candidate['reason'] !== null) {
      rejections.push({
        path: `${path}.reason`,
        reason: 'invalid-resolved-subject',
        detail: `reason must be null when status is ${String(status)} (resolved), got ${JSON.stringify(candidate['reason'])}`,
      });
    }
  }

  // Optional: absent is fine (a resolution with no traceable origin),
  // but present means exactly 'prose' or 'regex' - never null or
  // anything else, per ResolvedSubject.origin's own type.
  const origin = candidate['origin'];
  if (origin !== undefined && origin !== 'prose' && origin !== 'regex') {
    rejections.push({
      path: `${path}.origin`,
      reason: 'invalid-resolved-subject',
      detail: `origin must be 'prose', 'regex', or absent, got ${JSON.stringify(origin)}`,
    });
  }

  // phrase/similarity/alternatives were previously never checked at all -
  // not even for presence. A real Gemini generation returned a via with
  // only status/target/origin/reason and none of these three, and this
  // function accepted it: isRecord() plus the status-consistency checks
  // above say nothing about whether phrase/similarity/alternatives exist,
  // so a partial object with just the four fields already checked passed
  // silently. Required the same way every other required string/number/
  // array field in this module already is.
  if (!isNonEmptyString(candidate['phrase'])) {
    rejections.push({ path: `${path}.phrase`, reason: 'missing-or-wrong-type', expected: 'non-empty string' });
  }

  if (typeof candidate['similarity'] !== 'number') {
    rejections.push({ path: `${path}.similarity`, reason: 'missing-or-wrong-type', expected: 'number' });
  }

  const alternatives = candidate['alternatives'];
  if (!Array.isArray(alternatives) || !alternatives.every((item) => typeof item === 'string')) {
    rejections.push({ path: `${path}.alternatives`, reason: 'missing-or-wrong-type', expected: 'array of strings' });
  }

  return rejections;
}

/**
 * Field-level validation of a ConstraintSource. Previously isRecord()
 * only - a real Gemini response returned line: {} and timestamp: {}
 * (empty objects, not the number|null / string|null the type requires)
 * and validateProjectSchema accepted it anyway.
 */
function validateConstraintSource(candidate: Record<string, unknown>, path: string): readonly ProjectSchemaRejection[] {
  const rejections: ProjectSchemaRejection[] = [];

  const line = candidate['line'];
  if (line !== null && typeof line !== 'number') {
    rejections.push({ path: `${path}.line`, reason: 'missing-or-wrong-type', expected: 'number or null' });
  }

  const timestamp = candidate['timestamp'];
  if (timestamp !== null && typeof timestamp !== 'string') {
    rejections.push({ path: `${path}.timestamp`, reason: 'missing-or-wrong-type', expected: 'string or null' });
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
  rejections.push(...validateResolvedSubject(candidate['subject'], `${path}.subject`));
  rejections.push(...validateResolvedSubject(candidate['object'], `${path}.object`));

  // via is required (ResolvedSubject | null), not optional - a missing
  // key is `undefined`, which is !== null and so still gets validated
  // (and correctly rejected as not-an-object) below.
  const via = candidate['via'];
  if (via !== null) {
    rejections.push(...validateResolvedSubject(via, `${path}.via`));
  }

  if (!isRecord(candidate['source'])) {
    rejections.push({ path: `${path}.source`, reason: 'missing-or-wrong-type', expected: 'object' });
  } else {
    rejections.push(...validateConstraintSource(candidate['source'], `${path}.source`));
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
    // Every key on domains must be one of the 4 canonical DOMAIN_NAMES.
    // Previously unchecked: the loop below only ever reads the 4
    // canonical keys, so an extra key (e.g. a case-variant like
    // 'Database' alongside 'database') was silently retained on the
    // object returned as a 'validated' ProjectSchema - never inspected,
    // never flagged. A different reason from unknown-domain-dependency:
    // that one is a bad value inside a dependsOn array, this is a bad
    // key on the domains object itself.
    for (const key of Object.keys(domains)) {
      if (!(DOMAIN_NAMES as readonly string[]).includes(key)) {
        rejections.push({ path: `$.domains.${key}`, reason: 'unrecognized-domain-key', value: key });
      }
    }
    for (const domainName of DOMAIN_NAMES) {
      rejections.push(...validateDomainSpec(domains[domainName], domainName, `$.domains.${domainName}`, seenComponentIds));
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
