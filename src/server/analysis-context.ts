/**
 * Turns one finished pipeline run into the context the analysis routes serve.
 *
 * Shared by the CLI (the project it was started in) and the projects routes
 * (a folder or Git repository chosen from the UI), so a project analysed from
 * the browser is served exactly as one analysed from the command line.
 */
import type { RunResult } from '../pipeline/run.js';
import { createBlueprintStore } from '../store/blueprint-store.js';
import type { AnalysisContext } from './context.js';

export function toAnalysisContext(run: RunResult): AnalysisContext {
  const { analysis, labels, correctionOutcomes, intent, conformance, db, store } = run;
  return {
    root: analysis.walk.root,
    graph: analysis.graph,
    ingest: analysis.ingest,
    parse: analysis.parseSummary,
    parseFailures: analysis.parse.failures,
    clustering: analysis.clustering,
    labels,
    correctionOutcomes,
    intent,
    conformance,
    store,
    db,
    blueprintStore: createBlueprintStore(db),
  };
}
