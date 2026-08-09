/**
 * How badly a violation should be taken.
 *
 * ## The formula, in one sentence
 *
 * **Severity is how much we trust the rule multiplied by how much we trust the
 * evidence, scaled by how entrenched the breach is.**
 *
 *     score = constraintConfidence x edgeTrust x entrenchment
 *
 * Every term is a number the project already computes for its own reasons, and
 * every term is in 0..1, so the product is too. High is >= 0.7, medium >= 0.4,
 * low below that.
 *
 * ## Why multiply rather than add
 *
 * Because any one of the three being near zero should sink the whole thing, and
 * a weighted sum cannot express that. A rule the extractor was unsure of, broken
 * by an edge we resolved badly, is not a medium-severity finding just because it
 * happens to be broken in fifty places — it is a guess about a guess, and the
 * arithmetic should say so. Multiplication makes each factor a veto; addition
 * lets a strong term carry a weak one.
 *
 * ## The three terms
 *
 * **constraintConfidence** — straight from Week 7. Where the rule was written,
 * how it was phrased, whether its subjects resolved. A rule from AGENTS.md
 * saying "must never" scores near 1; a README saying "we prefer" scores low, and
 * a preference broken is not an incident.
 *
 * **edgeTrust** — how sure we are the dependency is real. Derived edges traced
 * to a resolved import are 1.0. This is where the resolver's honesty in Week 3
 * pays off: a module whose imports we largely failed to resolve is a module we
 * are only partly looking at, and a violation found inside it deserves less
 * weight than one found in a module we read cleanly.
 *
 * **entrenchment** — how woven-in the breach is, from the import count. One
 * import is a mistake someone can delete this afternoon; forty imports is a
 * structure that has grown around the violation, and removing it is a project.
 * Saturating rather than linear, because the difference between one and five
 * imports matters far more than the difference between forty and fifty.
 *
 * Crucially this term is bounded *below* at 0.6 rather than reaching zero. The
 * rule is broken either way — a single import through a forbidden boundary is
 * still a breach of that boundary, and a term that ran to zero would file a
 * clear-cut, high-confidence, one-import violation as "low", which is the
 * opposite of useful. Entrenchment adjusts severity within a band; it does not
 * decide whether something counts.
 *
 * ## What is deliberately not in here
 *
 * Nothing about how "important" a module looks — not file count, not centrality,
 * not fan-in. Those measure the size of a thing, and severity here is about
 * confidence in a claim, not the blast radius of the code. Mixing the two would
 * make big modules produce high-severity findings by default, which is how a
 * conformance report turns into noise nobody reads.
 */
import type { Severity, SeverityBreakdown } from '../types/violations.js';

export const HIGH_THRESHOLD = 0.7;
export const MEDIUM_THRESHOLD = 0.4;

/**
 * Import count at which entrenchment is effectively saturated.
 *
 * Chosen so a single import sits near 0.5 and a handful approaches 1: the
 * interesting distinction is "someone did this once" against "this is now load
 * bearing", and both ends flatten out quickly after that.
 */
const ENTRENCHMENT_HALF_LIFE = 3;

/**
 * Floor for the entrenchment term. A breach is a breach at one import.
 *
 * With this floor, a maximally confident rule broken once in a cleanly resolved
 * module scores 0.70 — high, which is correct. Without it the same violation
 * scored 0.25 and was filed as low.
 */
const MIN_ENTRENCHMENT = 0.6;

export interface SeverityInput {
  /** 0..1 from Week 7. */
  readonly constraintConfidence: number;
  /**
   * Resolution rate of the *modules involved*, 0..1. Not the whole repository:
   * a violation inside a cleanly resolved corner should not be discounted
   * because some unrelated package uses dynamic imports.
   */
  readonly localResolutionRate: number;
  /** Distinct import statements behind the violating edges. */
  readonly importCount: number;
  /**
   * False when any implicated edge is not DERIVED. Should never happen — the
   * graph only contains derived edges — but the check is cheap and the
   * alternative is a violation built on a stated edge, which rule 2 forbids.
   */
  readonly allEdgesDerived: boolean;
}

export function scoreSeverity(input: SeverityInput): SeverityBreakdown {
  const factors: string[] = [];

  const confidence = clamp(input.constraintConfidence);
  factors.push(`rule confidence ${confidence.toFixed(2)}`);

  /**
   * A non-derived edge cannot support a violation at all.
   *
   * Returning zero rather than a small number is deliberate: this is not a weak
   * finding, it is a finding that must not exist, and a score that rounds to
   * "low" would let it appear in a report as a minor issue.
   */
  if (!input.allEdgesDerived) {
    return {
      score: 0,
      severity: 'low',
      factors: [...factors, 'not all edges are DERIVED (x0) — this violation should not have been built'],
    };
  }

  const edgeTrust = clamp(input.localResolutionRate);
  factors.push(`local resolution ${(edgeTrust * 100).toFixed(1)}%`);

  const entrenchment = saturate(Math.max(0, input.importCount));
  factors.push(`${input.importCount} import(s) → entrenchment ${entrenchment.toFixed(2)}`);

  const score = round(confidence * edgeTrust * entrenchment);
  return { score, severity: bandOf(score), factors: [...factors, `product ${score.toFixed(3)}`] };
}

/** Floor plus a saturating curve: 1 import → 0.70, 3 → 0.80, 9 → 0.90, 27 → 0.96. */
function saturate(count: number): number {
  if (count === 0) return 0;
  return MIN_ENTRENCHMENT + (1 - MIN_ENTRENCHMENT) * (count / (count + ENTRENCHMENT_HALF_LIFE));
}

export function bandOf(score: number): Severity {
  if (score >= HIGH_THRESHOLD) return 'high';
  if (score >= MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  // Fixed precision so the same inputs give a byte-identical score across runs
  // and platforms; floating-point drift would break the determinism test.
  return Number(value.toFixed(6));
}
