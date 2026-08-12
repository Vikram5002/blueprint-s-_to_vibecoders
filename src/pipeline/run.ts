/**
 * One full run: analyse, apply stored corrections, label, read intent, record.
 *
 * The order is the architecture. Deterministic analysis first; user corrections
 * next, because a person's decision outranks the algorithm's; labelling after
 * that, because a name is cosmetic and must not be able to influence either.
 *
 * Intent extraction runs after that and touches nothing. It needs finished modules,
 * because a constraint's subject resolves against them, and it produces STATED
 * data that is kept entirely separate from the graph. Week 8 compares the two;
 * this week they only ever sit side by side.
 */
import { stat, readFile } from 'node:fs/promises';
import { analyseRepository, type Analysis, type AnalysisFailure, type AnalysisProgress } from './analyse.js';
import { labelRepository } from './label-repository.js';
import { extractIntent, candidatesFrom, type IntentRunResult } from './intent.js';
import { checkConformance } from './conformance.js';
import { openDatabase, databasePathFor, type BlueprintDatabase } from '../store/database.js';
import { createCorrectionsStore, type CorrectionsStore } from '../store/corrections-store.js';
import { createBlueprintStore } from '../store/blueprint-store.js';
import { mergeAuthoredConstraints } from '../blueprint/merge.js';
import { compileBlueprint, type CompileBlueprintResult } from '../blueprint/dsl.js';
import { err, ok, type Result } from '../types/result.js';
import type { LabelSet } from '../types/labels.js';
import type { Correction, CorrectionOutcome } from '../types/corrections.js';
import type { ConformanceResult } from '../types/violations.js';

export interface RunOptions {
  readonly root: string;
  readonly useModel?: boolean;
  /**
   * Skip model labelling while still extracting intent.
   *
   * Corpus collection sets this. Labelling costs one call per module and
   * extraction one per document, and across the first ten corpus repositories
   * that was 4,896 calls against 29 — 99.4% of the quota spent on names, for a
   * study that measures constraints and violations.
   *
   * Not a free choice, and deliberately named `mechanicalLabels` rather than
   * anything implying labels do not matter. They are cosmetic to *clustering*
   * — Week 5 pins that — but `conformance/resolve-subject.ts` tokenises a
   * module's label when matching a prose phrase to a module, so this can in
   * principle change which constraints resolve. See docs/FINDINGS.md for the
   * evidence that it does not in practice, and the check that would catch it
   * if it ever did.
   */
  readonly mechanicalLabels?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly onProgress?: (progress: AnalysisProgress) => void;
  readonly onLabelProgress?: (done: number, total: number, moduleId: string) => void;
  readonly onIntentProgress?: (done: number, total: number, location: string) => void;
  /**
   * Path to a blueprint DSL file to (re-)compile and persist this run.
   *
   * Authoring is deliberately a side effect of an ordinary run rather than a
   * separate command: compiling needs the same resolved modules extraction
   * uses, and persisting immediately means the very next run — including an
   * MCP session with no `--blueprint` flag at all — sees the authored rules
   * without the user having to re-supply the file. Omit to leave whatever was
   * last saved untouched.
   */
  readonly blueprintFile?: string;
}

export interface RunResult {
  readonly analysis: Analysis;
  readonly labels: LabelSet;
  readonly corrections: readonly Correction[];
  readonly correctionOutcomes: readonly CorrectionOutcome[];
  /** STATED data. Never merged with the graph; see rule 2. */
  readonly intent: IntentRunResult;
  /** Where the two halves disagree. Neither is modified to produce it. */
  readonly conformance: ConformanceResult;
  /** Open handle, so a server can accept corrections during the session. */
  readonly db: BlueprintDatabase;
  readonly store: CorrectionsStore;
  /** Present only when `blueprintFile` was given — this run's compile output. */
  readonly blueprintCompile: CompileBlueprintResult | null;
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
    // `mechanicalLabels` forces the no-model path for labelling only; intent
    // extraction below still runs against the model.
    ...(options.mechanicalLabels === true
      ? { useModel: false }
      : options.useModel === undefined
        ? {}
        : { useModel: options.useModel }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.onLabelProgress === undefined ? {} : { onProgress: options.onLabelProgress }),
  });

  const extracted = await extractIntent({
    root: options.root,
    clustering: analysed.value.clustering,
    labels,
    ...(options.useModel === undefined ? {} : { useModel: options.useModel }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.onIntentProgress === undefined ? {} : { onProgress: options.onIntentProgress }),
  });

  // Type-1: constraints a person authored directly, persisted from the last
  // `--blueprint` run. Merged here — the one point where "authored" and
  // "extracted" stop being two systems — so everything downstream
  // (conformance, MCP's get_constraints/check_import, the UI) sees one
  // constraint set and cannot tell the two apart except by source.type.
  const blueprintStore = createBlueprintStore(db);
  let blueprintCompile: CompileBlueprintResult | null = null;

  if (options.blueprintFile !== undefined) {
    const text = await readFile(options.blueprintFile, 'utf8');
    const directories = [...new Set(analysed.value.clustering.modules.flatMap((m) => m.directories))].sort();
    blueprintCompile = compileBlueprint({
      text,
      location: options.blueprintFile,
      modules: candidatesFrom(analysed.value.clustering, labels),
      directories,
    });
    // Replaces the whole stored blueprint: a rule deleted from the file must
    // disappear from what an agent sees next, not linger as a stale entry.
    blueprintStore.replace(blueprintCompile.constraints);
  }

  const intent = mergeAuthoredConstraints(extracted, blueprintStore.list());

  // Last, and reads only what the earlier stages produced. Comparing the two
  // halves cannot change either of them.
  const conformance = checkConformance({
    graph: analysed.value.graph,
    clustering: analysed.value.clustering,
    constraints: intent.constraints,
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
    conformance,
    db,
    store,
    blueprintCompile,
  });
}
