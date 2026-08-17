/**
 * Part A.2: seeding candidate constraints from the current derived graph.
 *
 * "Start from current" instead of a blank canvas: offer the user the
 * layering that already holds, as candidates they can accept, reject or
 * edit — never as constraints outright.
 *
 * The one dangerous mistake this file must not make: producing a `Constraint`
 * that is really just the derived graph wearing STATED's clothes. If an
 * observed edge were silently promoted to a rule, conformance would be
 * trivially satisfied by construction — the unmeasured-zero family again, in
 * its most subtle form, because nothing about the number would look wrong.
 * Two things hold this open:
 *
 *  1. `source.type` is always `'seeded-from-derived'`, never `'user-authored'`
 *     — see constraints.ts's comment on why the distinction matters to the
 *     paper as well as to the UI.
 *  2. Nothing in this file writes to the blueprint store. It only returns
 *     candidates; `src/server/blueprint-api.ts`'s accept endpoint is the one
 *     and only place a seed can become a persisted constraint, and only for
 *     ids a caller explicitly names.
 */
import { constraintId } from './dsl.js';
import { scoreConfidence } from '../conformance/confidence.js';
import type { Constraint, ConstraintSource, ResolvedSubject } from '../types/constraints.js';
import type { ClusteringResult, ModuleNode } from '../types/modules.js';

/** No file backs a seed — it is read off the graph, not off a document. */
const SEED_LOCATION = 'derived-graph:module-edges';

/**
 * One `must-be-layer-above` candidate per module pair whose current coupling
 * is one-directional: A imports B, B never imports A. That direction already
 * holds, so the candidate rule is "codify what is true today", not a guess.
 *
 * Pairs with edges in both directions are skipped — that is existing mutual
 * coupling, not a clean boundary, and proposing a layering rule for it would
 * immediately be violated by the very edge that justified proposing it.
 */
export function seedConstraintsFromDerived(clustering: ClusteringResult): Constraint[] {
  const byId = new Map(clustering.modules.map((module) => [module.id, module]));
  const forward = new Set<string>(clustering.edges.map((edge) => pairKey(edge.from, edge.to)));

  const seen = new Set<string>();
  const seeds: Constraint[] = [];

  for (const edge of clustering.edges) {
    if (edge.from === edge.to) {
      continue;
    }
    if (forward.has(pairKey(edge.to, edge.from))) {
      // Mutual coupling: not a one-directional boundary to codify.
      continue;
    }

    const unordered = [edge.from, edge.to].sort().join(' ');
    if (seen.has(unordered)) {
      continue;
    }
    seen.add(unordered);

    const subjectModule = byId.get(edge.from);
    const objectModule = byId.get(edge.to);
    if (subjectModule === undefined || objectModule === undefined) {
      continue;
    }

    seeds.push(buildSeed(subjectModule, objectModule));
  }

  return seeds.sort((a, b) => a.id.localeCompare(b.id));
}

function pairKey(from: string, to: string): string {
  return `${from} ${to}`;
}

function buildSeed(subjectModule: ModuleNode, objectModule: ModuleNode): Constraint {
  const rawText = `${subjectModule.label} must be layer above ${objectModule.label}`;
  const subject = moduleRole(subjectModule);
  const object = moduleRole(objectModule);

  const source: ConstraintSource = {
    type: 'seeded-from-derived',
    location: SEED_LOCATION,
    line: null,
    timestamp: null,
  };

  const confidence = scoreConfidence({
    sourceType: 'seeded-from-derived',
    rawText,
    subject,
    object,
    via: null,
    quoteVerified: true,
  });

  return {
    id: constraintId('must-be-layer-above', subject.phrase, object.phrase, rawText, source),
    relation: 'must-be-layer-above',
    subject,
    object,
    via: null,
    source,
    confidence: confidence.score,
    lowConfidence: confidence.lowConfidence,
    rawText,
    provenance: 'STATED',
  };
}

/** A seed already knows its module — no fuzzy resolution needed, so it resolves at full confidence. */
function moduleRole(module: ModuleNode): ResolvedSubject {
  return {
    phrase: module.label,
    status: 'MODULE',
    target: module.id,
    reason: null,
    similarity: 1,
    alternatives: [],
  };
}
