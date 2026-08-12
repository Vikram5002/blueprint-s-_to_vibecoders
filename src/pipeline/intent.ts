/**
 * Composition root for intent extraction.
 *
 * The one file that decides whether a model reads the repository's prose. Rule
 * 1 holds because this file, not `conformance/`, imports `llm/`: discovery,
 * subject resolution, compilation and scoring are all deterministic and none of
 * them knows a provider exists.
 *
 * Stage ordering matters and is fixed. Clustering finishes first, because
 * subjects resolve against modules; extraction then runs against documents;
 * nothing here touches the graph. A constraint is never turned into an edge.
 */
import { discoverIntentDocuments, splitStatements, type IntentDocument } from '../conformance/sources.js';
import { compileCandidates } from '../conformance/compile.js';
import { summariseSubjects } from '../conformance/resolve-subject.js';
import { loadLabelCache } from '../llm/cache.js';
import { chooseProvider, createProvider } from '../llm/select-provider.js';
import { createCachedExtractor } from '../llm/extract-intent.js';
import type { ResolutionCandidate } from '../conformance/resolve-subject.js';
import type { ClusteringResult } from '../types/modules.js';
import type { LabelSet } from '../types/labels.js';
import type {
  Constraint,
  ConstraintRelation,
  ExtractionSummary,
  IntentResult,
  ResolvedSubject,
  UncheckableReason,
  UncheckableStatement,
} from '../types/constraints.js';

export interface IntentOptions {
  readonly root: string;
  readonly clustering: ClusteringResult;
  readonly labels: LabelSet;
  /** Set false to force the no-model path even when a key is present. */
  readonly useModel?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly onProgress?: (done: number, total: number, location: string) => void;
  /** Injected in tests, so the whole stage can run without a provider. */
  readonly documents?: readonly IntentDocument[];
}

export interface IntentRunResult extends IntentResult {
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly estimatedCostUsd: number;
    readonly cacheHits: number;
    readonly cacheMisses: number;
  };
  readonly failures: readonly { readonly location: string; readonly reason: string }[];
}

const NO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  estimatedCostUsd: 0,
  cacheHits: 0,
  cacheMisses: 0,
} as const;

export async function extractIntent(options: IntentOptions): Promise<IntentRunResult> {
  const env = options.env ?? process.env;
  const documents = options.documents ?? (await discoverIntentDocuments({ root: options.root }));
  const modules = candidatesFrom(options.clustering, options.labels);
  const directories = [...new Set(options.clustering.modules.flatMap((module) => module.directories))].sort();

  const provider = options.useModel === false ? null : await createProvider(chooseProvider(env));
  if (provider === null || documents.length === 0) {
    /**
     * No key, or nothing to read.
     *
     * Unlike labelling, there is no mechanical fallback. A cluster always has a
     * path prefix to fall back on; a constraint has no deterministic
     * equivalent, because reading an obligation out of an English sentence is
     * the entire task. Pattern-matching "must not import" would produce a
     * different and much worse tool, and would quietly report a low constraint
     * count as though it were a finding about the repository.
     *
     * So the honest degraded result is empty, flagged, and reported as "not
     * attempted" rather than "none found".
     */
    return {
      constraints: [],
      uncheckable: [],
      summary: emptySummary(documents.length, true),
      usage: NO_USAGE,
      failures: [],
    };
  }

  const cache = await loadLabelCache(options.root);
  const extractor = createCachedExtractor({
    provider,
    cache,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });

  const moduleHints = modules.map((module) => module.label).sort();
  const result = await extractor.extract(
    documents.map((document) => ({
      location: document.location,
      documentText: document.text,
      moduleHints,
    })),
  );
  await cache.flush();

  const byLocation = new Map(documents.map((document) => [document.location, document]));
  const constraints: Constraint[] = [];
  const uncheckable: UncheckableStatement[] = [];
  let architecturalStatements = 0;

  for (const outcome of result.outcomes) {
    const document = byLocation.get(outcome.location);
    if (document === undefined) continue;

    architecturalStatements += outcome.candidates.length;
    const compiled = compileCandidates({
      candidates: outcome.candidates,
      source: {
        type: document.type,
        location: document.location,
        line: null,
        timestamp: document.timestamp,
      },
      documentText: document.text,
      modules,
      directories,
    });

    constraints.push(...compiled.constraints);
    uncheckable.push(...compiled.uncheckable);
  }

  // Line numbers come from the deterministic splitter, not the model: it knows
  // where each sentence actually sits, and the model would have to be trusted.
  const located = constraints.map((constraint) => withLineNumber(constraint, byLocation));

  return {
    constraints: located.sort((a, b) => a.id.localeCompare(b.id)),
    uncheckable,
    summary: summarise(
      documents.length,
      architecturalStatements,
      located,
      uncheckable,
      false,
      result.failures.filter((failure) => failure.incomplete).length,
    ),
    usage: result.usage,
    failures: result.failures,
  };
}

/**
 * Finds the line a constraint's sentence sits on.
 *
 * Rule 3 wants a location a reader can open, and the model is not asked for one
 * — it would be guessing, and a wrong line number is worse than none because it
 * looks checkable. The splitter already walked the document with line numbers,
 * so the answer is available deterministically.
 */
function withLineNumber(constraint: Constraint, documents: ReadonlyMap<string, IntentDocument>): Constraint {
  const document = documents.get(constraint.source.location);
  if (document === undefined) return constraint;

  const needle = constraint.rawText.toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  for (const statement of splitStatements(document)) {
    const candidate = statement.text.toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
    if (candidate.includes(needle) || needle.includes(candidate)) {
      return { ...constraint, source: { ...constraint.source, line: statement.source.line } };
    }
  }
  return constraint;
}

export function candidatesFrom(clustering: ClusteringResult, labels: LabelSet): ResolutionCandidate[] {
  return clustering.modules.map((module) => ({
    moduleId: module.id,
    label: labels.labels.get(module.id)?.label ?? module.label,
    directories: module.directories,
    fileCount: module.files.length,
  }));
}

function emptyRelations(): Record<ConstraintRelation, number> {
  return {
    'must-not-import': 0,
    'may-only-import-via': 0,
    'must-not-cycle': 0,
    'must-be-layer-above': 0,
  };
}

function emptyUncheckable(): Record<UncheckableReason, number> {
  return {
    'style-preference': 0,
    'process-rule': 0,
    'runtime-behaviour': 0,
    'unsupported-relation': 0,
    'descriptive-not-normative': 0,
    'technology-choice': 0,
  };
}

function emptySummary(documents: number, degraded: boolean): ExtractionSummary {
  return {
    documents,
    architecturalStatements: 0,
    constraints: 0,
    uncheckable: 0,
    byUncheckableReason: emptyUncheckable(),
    byRelation: emptyRelations(),
    lowConfidence: 0,
    evaluable: 0,
    subjects: summariseSubjects([]),
    degraded,
    incompleteDocuments: 0,
  };
}

export function summarise(
  documents: number,
  architecturalStatements: number,
  constraints: readonly Constraint[],
  uncheckable: readonly UncheckableStatement[],
  degraded: boolean,
  incompleteDocuments: number,
): ExtractionSummary {
  const byRelation = emptyRelations();
  const byUncheckableReason = emptyUncheckable();

  const subjects: ResolvedSubject[] = [];
  let lowConfidence = 0;
  let evaluable = 0;

  for (const constraint of constraints) {
    byRelation[constraint.relation] += 1;
    if (constraint.lowConfidence) lowConfidence += 1;

    const roles = [constraint.subject, constraint.object, ...(constraint.via === null ? [] : [constraint.via])];
    subjects.push(...roles);
    if (roles.every((role) => role.status !== 'UNRESOLVED')) evaluable += 1;
  }

  for (const statement of uncheckable) byUncheckableReason[statement.reason] += 1;

  return {
    documents,
    architecturalStatements,
    constraints: constraints.length,
    uncheckable: uncheckable.length,
    byUncheckableReason,
    byRelation,
    lowConfidence,
    evaluable,
    subjects: summariseSubjects(subjects),
    degraded,
    incompleteDocuments,
  };
}
