/**
 * Scoring extraction against the hand-labelled set.
 *
 * ## Matching rule
 *
 * A predicted constraint matches a gold one when the relation is identical and
 * the subject and object phrases agree after normalisation. Matching on the
 * quoted sentence was rejected: the same rule can be extracted from a sentence
 * split at a different point, and scoring would then measure sentence
 * segmentation rather than comprehension. What is being tested is whether the
 * tool understood *what constrains what*.
 *
 * Normalisation drops articles, trailing slashes, markdown, and the filler words
 * that carry no discriminating power, so `parser/`, `the parser` and `the parser
 * layer` are the same subject. This is generous on purpose. A stricter rule
 * would report failures that are really disagreements about phrasing, and
 * inflate the apparent difficulty of the task.
 *
 * ## Why precision is reported before recall everywhere
 *
 * The project's own proposal says a false violation damages trust more than a
 * missed one. Precision is therefore the number that decides whether this
 * approach is viable, and recall is the number that decides how useful it is.
 */
import type { ConstraintRelation } from '../types/constraints.js';

export interface ScorableConstraint {
  readonly relation: ConstraintRelation;
  readonly subject: string;
  readonly object: string;
  readonly file: string;
}

export interface ConfusionMatrix {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  /** Documents correctly yielding no constraints. */
  readonly trueNegativeDocuments: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly missed: readonly ScorableConstraint[];
  readonly spurious: readonly ScorableConstraint[];
}

const FILLER = new Set([
  'the', 'a', 'an', 'our', 'this', 'that', 'layer', 'layers', 'module', 'modules',
  'package', 'packages', 'directory', 'folder', 'code', 'logic', 'component',
  'components', 'tier', 'level', 'side', 'part',
]);

export function normalisePhrase(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '' && !FILLER.has(token))
    .map((token) => (token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token))
    .sort()
    .join(' ');
}

function keyOf(constraint: ScorableConstraint): string {
  return [constraint.relation, normalisePhrase(constraint.subject), normalisePhrase(constraint.object)].join('|');
}

export function score(
  predicted: readonly ScorableConstraint[],
  gold: readonly ScorableConstraint[],
  documentsWithNoGold: number,
): ConfusionMatrix {
  // Scoped per document: the same rule in two files is two separate claims, and
  // matching one against the other would credit the tool for finding a
  // constraint in a document that does not contain it.
  const goldRemaining = new Map<string, ScorableConstraint[]>();
  for (const entry of gold) {
    const key = `${entry.file}::${keyOf(entry)}`;
    const bucket = goldRemaining.get(key);
    if (bucket === undefined) goldRemaining.set(key, [entry]);
    else bucket.push(entry);
  }

  const spurious: ScorableConstraint[] = [];
  let truePositives = 0;

  for (const entry of predicted) {
    const key = `${entry.file}::${keyOf(entry)}`;
    const bucket = goldRemaining.get(key);
    if (bucket !== undefined && bucket.length > 0) {
      bucket.pop();
      truePositives += 1;
    } else {
      spurious.push(entry);
    }
  }

  const missed = [...goldRemaining.values()].flat();
  const falsePositives = spurious.length;
  const falseNegatives = missed.length;

  const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall = truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  // A document correctly yielding nothing is a real success and the corpus is
  // mostly made of them, so it is reported — but kept out of precision and
  // recall, where it would drown the handful of positives and make a
  // do-nothing extractor look excellent.
  const trueNegativeDocuments = documentsWithNoGold - new Set(spurious.map((entry) => entry.file)).size;

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegativeDocuments,
    precision,
    recall,
    f1,
    missed,
    spurious,
  };
}

export function formatMatrix(matrix: ConfusionMatrix): string {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const lines = [
    `  precision            ${percent(matrix.precision)}   (${matrix.truePositives} correct of ${matrix.truePositives + matrix.falsePositives} predicted)`,
    `  recall               ${percent(matrix.recall)}   (${matrix.truePositives} found of ${matrix.truePositives + matrix.falseNegatives} labelled)`,
    `  F1                   ${percent(matrix.f1)}`,
    `  clean documents      ${matrix.trueNegativeDocuments} produced nothing, correctly`,
  ];

  if (matrix.missed.length > 0) {
    lines.push('', '  missed:');
    for (const entry of matrix.missed) {
      lines.push(`    ${entry.file}  ${entry.relation}(${entry.subject} -> ${entry.object})`);
    }
  }
  if (matrix.spurious.length > 0) {
    lines.push('', '  spurious:');
    for (const entry of matrix.spurious) {
      lines.push(`    ${entry.file}  ${entry.relation}(${entry.subject} -> ${entry.object})`);
    }
  }
  return lines.join('\n');
}
