/**
 * Turning raw extraction candidates into constraints, or into counted refusals.
 *
 * Everything the model produced arrives here as untrusted data and leaves as
 * one of three things: a Constraint, an UncheckableStatement, or a rejection.
 * Nothing passes through unexamined, and no path in this file produces a
 * constraint whose text nobody wrote.
 *
 * Deterministic: same candidates in, same constraints out, including ids.
 */
import { createHash } from 'node:crypto';
import { resolveSubject, type ResolutionCandidate } from './resolve-subject.js';
import { scoreConfidence } from './confidence.js';
import {
  CONSTRAINT_RELATIONS,
  type Constraint,
  type ConstraintRelation,
  type ConstraintSource,
  type UncheckableReason,
  type UncheckableStatement,
} from '../types/constraints.js';

/**
 * One statement as the extractor reported it. Field names match the JSON schema
 * the model is held to; every value is treated as hostile until checked.
 */
export interface RawCandidate {
  readonly rawText?: unknown;
  readonly relation?: unknown;
  readonly subject?: unknown;
  readonly object?: unknown;
  readonly via?: unknown;
  readonly uncheckableReason?: unknown;
}

export type RejectionReason =
  /** Not one of the four relations, and no uncheckable reason given either. */
  | 'unknown-relation'
  /** Missing a role the relation requires. */
  | 'incomplete-roles'
  /** The quoted sentence does not appear in any source document. */
  | 'quote-not-in-source'
  /** Empty or absurdly long raw text. */
  | 'malformed-text'
  /** The same statement was extracted twice. */
  | 'duplicate';

export interface Rejection {
  readonly rawText: string;
  readonly reason: RejectionReason;
}

export interface CompileOptions {
  readonly candidates: readonly RawCandidate[];
  readonly source: ConstraintSource;
  /** The document body the candidates were extracted from, for quote checking. */
  readonly documentText: string;
  readonly modules: readonly ResolutionCandidate[];
  readonly directories?: readonly string[];
}

export interface CompileResult {
  readonly constraints: readonly Constraint[];
  readonly uncheckable: readonly UncheckableStatement[];
  readonly rejected: readonly Rejection[];
}

const UNCHECKABLE_REASONS: readonly UncheckableReason[] = [
  'style-preference',
  'process-rule',
  'runtime-behaviour',
  'unsupported-relation',
  'descriptive-not-normative',
  'technology-choice',
];

/** Long enough for any real sentence; short enough to bound a hostile payload. */
const MAX_RAW_TEXT = 500;

/**
 * The schema's explicit "this is not a dependency rule" answer.
 *
 * Not a ConstraintRelation — it exists so the model cannot stay silent. See
 * EXTRACT_SCHEMA for why silence was the failure mode worth designing out.
 */
const NOT_CHECKABLE = 'not-checkable';

export function compileCandidates(options: CompileOptions): CompileResult {
  const constraints: Constraint[] = [];
  const uncheckable: UncheckableStatement[] = [];
  const rejected: Rejection[] = [];
  const seen = new Set<string>();

  const normalisedDocument = normaliseForComparison(options.documentText);

  for (const candidate of options.candidates) {
    const rawText = typeof candidate.rawText === 'string' ? candidate.rawText.trim() : '';
    if (rawText === '' || rawText.length > MAX_RAW_TEXT) {
      rejected.push({ rawText: rawText.slice(0, 120), reason: 'malformed-text' });
      continue;
    }

    /**
     * The quote must exist in the document.
     *
     * This is the single most valuable deterministic check in the week. An
     * extraction step that can emit sentences is an extraction step that can
     * emit invented ones, and a constraint whose text nobody wrote is a
     * hallucination with a file path attached — rule 3 exists precisely to make
     * that impossible.
     *
     * It is not a defence against injection: a hostile sentence genuinely
     * present in a README passes this check, because it really is in the
     * document. What it does defend is the other direction, which is easy to
     * overlook — a model persuaded to *fabricate* a rule cannot also fabricate
     * its presence in the source.
     */
    if (!normalisedDocument.includes(normaliseForComparison(rawText))) {
      rejected.push({ rawText, reason: 'quote-not-in-source' });
      continue;
    }

    const uncheckableReason = asUncheckableReason(candidate.uncheckableReason);
    const relation = asRelation(candidate.relation);

    // An uncheckable reason wins over a relation. A model that supplies both is
    // hedging, and the conservative reading is that it did not fit the schema.
    if (uncheckableReason !== null) {
      uncheckable.push({ rawText, reason: uncheckableReason, source: options.source });
      continue;
    }

    /**
     * `not-checkable` without a reason still counts as uncheckable.
     *
     * The schema forces the model to classify every statement, and
     * `not-checkable` is the honest answer for most architectural prose. When
     * it declines to say *which* kind, the statement is still a real finding —
     * dropping it would undercount exactly the number the report exists to
     * show — so it lands under the generic reason rather than being rejected.
     */
    if (candidate.relation === NOT_CHECKABLE) {
      uncheckable.push({ rawText, reason: 'unsupported-relation', source: options.source });
      continue;
    }

    if (relation === null) {
      rejected.push({ rawText, reason: 'unknown-relation' });
      continue;
    }

    const subjectPhrase = asPhrase(candidate.subject);
    const objectPhrase = asPhrase(candidate.object);
    const viaPhrase = asPhrase(candidate.via);

    // `must-not-cycle` is the one relation that is legitimately unary.
    const needsObject = relation !== 'must-not-cycle';
    if (subjectPhrase === null || (needsObject && objectPhrase === null)) {
      rejected.push({ rawText, reason: 'incomplete-roles' });
      continue;
    }
    if (relation === 'may-only-import-via' && viaPhrase === null) {
      rejected.push({ rawText, reason: 'incomplete-roles' });
      continue;
    }

    const resolveOptions = {
      candidates: options.modules,
      ...(options.directories === undefined ? {} : { directories: options.directories }),
    };
    const subject = resolveSubject(subjectPhrase, resolveOptions);
    const object = resolveSubject(objectPhrase ?? subjectPhrase, resolveOptions);
    const via = viaPhrase === null ? null : resolveSubject(viaPhrase, resolveOptions);

    const confidence = scoreConfidence({
      sourceType: options.source.type,
      rawText,
      subject,
      object,
      via,
      quoteVerified: true,
    });

    const id = constraintId(relation, subject.phrase, object.phrase, rawText, options.source);
    if (seen.has(id)) {
      rejected.push({ rawText, reason: 'duplicate' });
      continue;
    }
    seen.add(id);

    constraints.push({
      id,
      relation,
      subject,
      object,
      via,
      source: options.source,
      confidence: confidence.score,
      lowConfidence: confidence.lowConfidence,
      rawText,
      provenance: 'STATED',
    });
  }

  // Sorted by id so the output does not depend on the order the model answered.
  return {
    constraints: constraints.sort((a, b) => a.id.localeCompare(b.id)),
    uncheckable,
    rejected,
  };
}

/**
 * Content-derived, including the source location.
 *
 * The same rule stated in both AGENTS.md and the README is two constraints, not
 * one: they are separate claims that can independently go stale, and collapsing
 * them would hide that one of the two documents was never updated.
 */
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
        '\u0000',
      ),
    )
    .digest('hex')
    .slice(0, 16);
}

function asRelation(value: unknown): ConstraintRelation | null {
  return typeof value === 'string' && (CONSTRAINT_RELATIONS as readonly string[]).includes(value)
    ? (value as ConstraintRelation)
    : null;
}

function asUncheckableReason(value: unknown): UncheckableReason | null {
  return typeof value === 'string' && (UNCHECKABLE_REASONS as readonly string[]).includes(value)
    ? (value as UncheckableReason)
    : null;
}

function asPhrase(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed.length > 120 ? null : trimmed;
}

/**
 * Whitespace- and case-insensitive comparison.
 *
 * A quote is checked against the document after both sides are flattened,
 * because a sentence that wrapped across two lines in the source is the same
 * sentence. Markdown emphasis is stripped for the same reason: the model
 * reasonably returns `the api layer` where the file said `the *api* layer`.
 */
function normaliseForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
