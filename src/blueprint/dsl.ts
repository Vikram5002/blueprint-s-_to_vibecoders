/**
 * The constraint-authoring DSL.
 *
 * Four line shapes, one per relation, deliberately mirroring the prose the
 * extraction pipeline already reads ("the domain layer must not import the
 * infra layer") so a user copying language out of their own README does not
 * have to learn new syntax:
 *
 *   domain must not import infra
 *   ui may only import shared via api
 *   domain must not cycle
 *   api must be layer above domain
 *
 * This is a sibling of `conformance/compile.ts`'s `compileCandidates`, not a
 * replacement for it — same subject resolver, same confidence scoring, same
 * content-derived id, same `Constraint` shape, same `provenance: 'STATED'`.
 * The one step that does not apply is the "quote exists in the source
 * document" check: that check exists because an LLM extraction step can
 * fabricate a sentence and then fabricate its presence in a README. A line a
 * user typed by hand has no document to have drifted from — the user is the
 * source — so `quoteVerified` is always true here and every other step is
 * identical to extraction's.
 */
import { createHash } from 'node:crypto';
import { resolveSubject, type ResolutionCandidate } from '../conformance/resolve-subject.js';
import { scoreConfidence } from '../conformance/confidence.js';
import type { Constraint, ConstraintRelation, ConstraintSource } from '../types/constraints.js';

export type BlueprintRejectionReason =
  /** No line shape matched. */
  | 'no-relation-matched'
  /** Matched a shape but a required phrase was empty. */
  | 'incomplete-roles';

export interface BlueprintRejection {
  readonly line: number;
  readonly text: string;
  readonly reason: BlueprintRejectionReason;
}

export interface CompileBlueprintOptions {
  readonly text: string;
  /** Recorded as the constraint's source location — typically the blueprint file path. */
  readonly location: string;
  readonly modules: readonly ResolutionCandidate[];
  readonly directories?: readonly string[];
}

export interface CompileBlueprintResult {
  readonly constraints: readonly Constraint[];
  readonly rejected: readonly BlueprintRejection[];
}

interface RuleMatch {
  readonly relation: ConstraintRelation;
  readonly subject: string;
  readonly object: string | null;
  readonly via: string | null;
}

/**
 * Checked in order. `may-only-import-via` must be tried before
 * `must-not-import` — a line containing "via" would also loosely match a
 * greedier "must not import" pattern otherwise.
 */
const RULE_MATCHERS: readonly ((line: string) => RuleMatch | null)[] = [
  (line) => {
    const match = /^(.+?)\s+may only import\s+(.+?)\s+via\s+(.+)$/i.exec(line);
    return match === null
      ? null
      : { relation: 'may-only-import-via', subject: match[1] ?? '', object: match[2] ?? '', via: match[3] ?? '' };
  },
  (line) => {
    const match = /^(.+?)\s+must not import\s+(.+)$/i.exec(line);
    return match === null
      ? null
      : { relation: 'must-not-import', subject: match[1] ?? '', object: match[2] ?? '', via: null };
  },
  (line) => {
    const match = /^(.+?)\s+must be layer above\s+(.+)$/i.exec(line);
    return match === null
      ? null
      : { relation: 'must-be-layer-above', subject: match[1] ?? '', object: match[2] ?? '', via: null };
  },
  (line) => {
    const match = /^(.+?)\s+must not cycle$/i.exec(line);
    return match === null ? null : { relation: 'must-not-cycle', subject: match[1] ?? '', object: null, via: null };
  },
];

function matchRule(line: string): RuleMatch | null {
  for (const matcher of RULE_MATCHERS) {
    const match = matcher(line);
    if (match !== null) {
      return match;
    }
  }
  return null;
}

/**
 * Compiles blueprint DSL text into the same `Constraint[]` shape the
 * extraction pipeline produces. Deterministic: same text in, same
 * constraints out, in the same order (sorted by id, matching
 * `compileCandidates`), so a blueprint applies identically across runs.
 */
export function compileBlueprint(options: CompileBlueprintOptions): CompileBlueprintResult {
  const constraints: Constraint[] = [];
  const rejected: BlueprintRejection[] = [];

  const lines = options.text.split(/\r\n|\r|\n/);
  const resolveOptions = {
    candidates: options.modules,
    ...(options.directories === undefined ? {} : { directories: options.directories }),
  };

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? '').trim();
    const lineNumber = index + 1;

    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const match = matchRule(trimmed);
    if (match === null) {
      rejected.push({ line: lineNumber, text: trimmed, reason: 'no-relation-matched' });
      continue;
    }

    const needsObject = match.relation !== 'must-not-cycle';
    if (match.subject.trim() === '' || (needsObject && (match.object ?? '').trim() === '')) {
      rejected.push({ line: lineNumber, text: trimmed, reason: 'incomplete-roles' });
      continue;
    }

    const subject = resolveSubject(match.subject.trim(), resolveOptions);
    const object = resolveSubject((match.object ?? match.subject).trim(), resolveOptions);
    const via = match.via === null ? null : resolveSubject(match.via.trim(), resolveOptions);

    const source: ConstraintSource = {
      type: 'user-authored',
      location: options.location,
      line: lineNumber,
      timestamp: null,
    };

    const confidence = scoreConfidence({
      sourceType: 'user-authored',
      rawText: trimmed,
      subject,
      object,
      via,
      quoteVerified: true,
    });

    const id = constraintId(match.relation, subject.phrase, object.phrase, trimmed, source);

    constraints.push({
      id,
      relation: match.relation,
      subject,
      object,
      via,
      source,
      confidence: confidence.score,
      lowConfidence: confidence.lowConfidence,
      rawText: trimmed,
      provenance: 'STATED',
    });
  }

  return {
    constraints: constraints.sort((a, b) => a.id.localeCompare(b.id)),
    rejected,
  };
}

/** Same construction as `compile.ts`'s `constraintId`, so ids stay comparable across sources. */
function constraintId(
  relation: ConstraintRelation,
  subject: string,
  object: string,
  rawText: string,
  source: ConstraintSource,
): string {
  return createHash('sha256')
    .update(
      [relation, subject.toLowerCase(), object.toLowerCase(), rawText, source.location, String(source.line)].join(
        ' ',
      ),
    )
    .digest('hex')
    .slice(0, 16);
}
