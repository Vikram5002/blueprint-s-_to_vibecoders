/**
 * Merging authored constraints into an extraction result.
 *
 * The single point where "authored" and "extracted" stop being two systems.
 * Both are already the same `Constraint` shape (see dsl.ts); this just
 * concatenates the arrays and recomputes the summary with the same
 * `summarise` function extraction itself uses — not a second tally.
 *
 * Concatenation, never a merge-by-content: an authored constraint that
 * happens to restate an extracted one is two independent claims (same
 * reasoning as compile.ts's constraintId comment on AGENTS.md vs README) —
 * they can go stale independently and collapsing them would hide that.
 */
import { summarise } from '../pipeline/intent.js';
import type { IntentRunResult } from '../pipeline/intent.js';
import type { Constraint } from '../types/constraints.js';

export function mergeAuthoredConstraints(
  intent: IntentRunResult,
  authored: readonly Constraint[],
): IntentRunResult {
  if (authored.length === 0) {
    return intent;
  }

  const constraints = [...intent.constraints, ...authored].sort((a, b) => a.id.localeCompare(b.id));

  const summary = summarise(
    intent.summary.documents,
    intent.summary.architecturalStatements + authored.length,
    constraints,
    intent.uncheckable,
    intent.summary.degraded,
    intent.summary.incompleteDocuments,
  );

  return {
    ...intent,
    constraints,
    summary,
  };
}
