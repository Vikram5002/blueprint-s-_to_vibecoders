/**
 * One full run: analyse, apply stored corrections, label, read intent, record.
 *
 * The order is the architecture. Deterministic analysis first; user corrections
 * next, because a person's decision outranks the algorithm's; labelling after
 * that, because a name is cosmetic and must not be able to influence either.
 *
 * Intent extraction runs last and touches nothing. It needs finished modules,
 * because a constraint's subject resolves against them, and it produces STATED
 * data that is kept entirely separate from the graph. Week 8 compares the two;
 * this week they only ever sit side by side.
 */
import { stat } from 'node:fs/promises';
import { analyseRepository, type Analysis, type AnalysisFailure, type AnalysisProgress } from './analyse.js';
import { labelRepository } from './label-repository.js';
import { extractIntent, type IntentRunResult } from './intent.js';
import { openDatabase, databasePathFor, type BlueprintDatabase } from '../store/database.js';
import { createCorrectionsStore, type CorrectionsStore } from '../store/corrections-store.js';
import { err, ok, type Result } from '../types/result.js';
import type { LabelSet } from '../types/labels.js';
import type { Correction, CorrectionOutcome } from '../types/corrections.js';

export interface RunOptions {
  readonly root: string;
  readonly useModel?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly onProgress?: (progress: AnalysisProgress) => void;
  readonly onLabelProgress?: (done: number, total: number, moduleId: string) => void;
  readonly onIntentProgress?: (done: number, total: number, location: string) => void;
}

export interface RunResult {
  readonly analysis: Analysis;
  readonly labels: LabelSet;
  readonly corrections: readonly Correction[];
  readonly correctionOutcomes: readonly CorrectionOutcome[];
  /** STATED data. Never merged with the graph; see rule 2. */
  readonly intent: IntentRunResult;
  /** Open handle, so a server can accept corrections during the session. */
  readonly db: BlueprintDatabase;
  readonly store: CorrectionsStore;
}

export async function runPipeline(options: RunOptions): Promise<Result<RunResult, AnalysisFailure>> {
  // Check the target is real before touching disk. Opening the database
  // creates .vibe/ under the root, so doing it first would silently create a
  // directory for a mistyped path and then report it as an empty repository.
  const rootStat = await stat(options.root).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory()) {
    return err({
      stage: 'walk',
      message: rootStat === null ? `path does not exist: ${options.root}` : `not a directory: ${options.root}`,
    });
  }

  const db = openDatabase(databasePathFor(options.root));
  const store = createCorrectionsStore(db);
  const corrections = store.list();

  const analysed = await analyseRepository({
    root: options.root,
    cluster: { corrections },
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });

  if (!analysed.ok) {
    db.close();
    return err(analysed.error);
  }

  const outcomes = analysed.value.clustering.correctionOutcomes;

  // Names the user gave outrank both the mechanical name and the model's, and
  // a module already named by hand is never sent to a model.
  const userLabels = new Map(Object.entries(analysed.value.clustering.correctionLabels));

  const labels = await labelRepository({
    root: options.root,
    clustering: analysed.value.clustering,
    files: analysed.value.parse.files,
    corrections: userLabels,
    ...(options.useModel === undefined ? {} : { useModel: options.useModel }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.onLabelProgress === undefined ? {} : { onProgress: options.onLabelProgress }),
  });

  const intent = await extractIntent({
    root: options.root,
    clustering: analysed.value.clustering,
    labels,
    ...(options.useModel === undefined ? {} : { useModel: options.useModel }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.onIntentProgress === undefined ? {} : { onProgress: options.onIntentProgress }),
  });

  // Recorded even when nothing was corrected, so a run is always comparable
  // against the corrections that were in force when it happened.
  store.recordRun(outcomes);

  return ok({
    analysis: analysed.value,
    labels,
    corrections,
    correctionOutcomes: outcomes,
    intent,
    db,
    store,
  });
}
