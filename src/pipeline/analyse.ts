/**
 * The deterministic pipeline, in one place.
 *
 * walk -> parse -> resolve -> graph -> cluster. Every stage here is
 * reproducible: the same repository always produces the same output, byte for
 * byte, and nothing in this file may consult a model.
 *
 * ## Why this layer exists
 *
 * Architectural rule 1 forbids `graph/` and `parser/` from importing `llm/`,
 * which means labelling cannot be called from inside clustering. Something has
 * to run the deterministic half, then the model, then attach the results — and
 * rule 5 forbids putting that in `cli/`. This is that something.
 *
 * The ordering is the point: labels are applied to a clustering that is already
 * final. They are never an input to it.
 */
import { walkRepository, type WalkResult } from '../ingest/walk.js';
import { summariseWalk, type IngestSummary } from '../ingest/summary.js';
import { parseRepository, summariseParse, type ParseSummary } from '../parser/parse-repository.js';
import { resolveRepository } from '../graph/resolve.js';
import { buildDependencyGraph, type DependencyGraph } from '../graph/build-graph.js';
import { clusterRepository, type ClusterOptions } from '../graph/cluster.js';
import { err, ok, type Result } from '../types/result.js';
import type { GrammarLoadError } from '../parser/grammars.js';
import type { ParseReport } from '../types/symbols.js';
import type { ClusteringResult } from '../types/modules.js';

/**
 * Structured, not pre-formatted. Wording belongs to `cli/output.ts`; the
 * pipeline reports what happened and lets the caller decide how to say it.
 */
export type AnalysisProgress =
  | {
      readonly stage: 'walk';
      readonly directoriesVisited: number;
      readonly filesFound: number;
      readonly currentDirectory: string;
    }
  | {
      readonly stage: 'parse';
      readonly filesParsed: number;
      readonly filesTotal: number;
      readonly currentFile: string;
    };

export interface AnalyseOptions {
  readonly root: string;
  readonly cluster?: ClusterOptions;
  readonly onProgress?: (progress: AnalysisProgress) => void;
}

export interface Analysis {
  /** Absolute, resolved repository root. */
  readonly root: string;
  readonly walk: WalkResult;
  readonly ingest: IngestSummary;
  readonly parse: ParseReport;
  readonly parseSummary: ParseSummary;
  readonly graph: DependencyGraph;
  readonly clustering: ClusteringResult;
}

export type AnalysisFailure =
  | { readonly stage: 'walk'; readonly message: string }
  | { readonly stage: 'parse'; readonly message: string };

export async function analyseRepository(
  options: AnalyseOptions,
): Promise<Result<Analysis, AnalysisFailure>> {
  const walked = await walkRepository({
    root: options.root,
    ...(options.onProgress === undefined
      ? {}
      : {
          onProgress: (progress) => options.onProgress?.({ stage: 'walk', ...progress }),
        }),
  });

  if (!walked.ok) {
    return err({ stage: 'walk', message: walked.error.message });
  }

  const parsed = await parseRepository({
    files: walked.value.files,
    ...(options.onProgress === undefined
      ? {}
      : {
          onProgress: (progress) => options.onProgress?.({ stage: 'parse', ...progress }),
        }),
  });

  if (!parsed.ok) {
    return err({ stage: 'parse', message: describeGrammarFailure(parsed.error) });
  }

  const resolution = await resolveRepository({ root: walked.value.root, files: parsed.value.files });
  const graph = buildDependencyGraph({ files: parsed.value.files, resolution });
  const clustering = clusterRepository(graph, options.cluster ?? {});

  return ok({
    root: walked.value.root,
    walk: walked.value,
    ingest: summariseWalk(walked.value),
    parse: parsed.value,
    parseSummary: summariseParse(parsed.value),
    graph,
    clustering,
  });
}

function describeGrammarFailure(failure: GrammarLoadError): string {
  return failure.message;
}
