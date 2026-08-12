/**
 * Aggregates a walk result into the numbers the CLI reports.
 * Pure: takes a WalkResult, returns counts. No I/O, no formatting.
 */
import type { Language } from './language.js';
import type { WalkResult } from './walk.js';

export type LanguageCounts = Readonly<Record<Language, number>>;

export interface IngestSummary {
  readonly root: string;
  readonly fileCount: number;
  readonly byLanguage: LanguageCounts;
  readonly totalBytes: number;
  readonly entriesSeen: number;
  readonly directoriesVisited: number;
  readonly filesIgnored: number;
  readonly directoriesSkipped: number;
  readonly filesUnsupported: number;
  readonly symlinksSkipped: number;
  readonly errorCount: number;
  readonly durationMs: number;
}

export function summariseWalk(result: WalkResult): IngestSummary {
  const byLanguage: Record<Language, number> = { typescript: 0, javascript: 0, python: 0, php: 0 };
  let totalBytes = 0;

  for (const file of result.files) {
    byLanguage[file.language] += 1;
    totalBytes += file.sizeBytes;
  }

  return {
    root: result.root,
    fileCount: result.files.length,
    byLanguage,
    totalBytes,
    entriesSeen: result.stats.entriesSeen,
    directoriesVisited: result.stats.directoriesVisited,
    filesIgnored: result.stats.filesIgnored,
    directoriesSkipped: result.stats.directoriesSkipped,
    filesUnsupported: result.stats.filesUnsupported,
    symlinksSkipped: result.stats.symlinksSkipped,
    errorCount: result.stats.errors.length,
    durationMs: result.durationMs,
  };
}
