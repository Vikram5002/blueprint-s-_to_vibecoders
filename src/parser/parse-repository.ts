/**
 * Drives the parser across a walked repository.
 *
 * Reads each file, parses it, and accumulates failures instead of aborting —
 * "prefer partial results over failure" (CLAUDE.md). Files whose language has
 * no extractor yet are reported as skipped, which is a different thing from a
 * failure and must not be counted as one.
 *
 * Sequential by design. PHASE-1-SPEC allows a worker pool; measurement showed
 * it is not needed to hit the Week 2 target, and concurrency added before it is
 * warranted is just risk. See the note in docs/PHASE-1-SPEC.md.
 */
import { readFile } from 'node:fs/promises';
import { ok, type Result } from '../types/result.js';
import { createSourceParser, type SourceParser } from './parse.js';
import type { GrammarLoadError } from './grammars.js';
import type { DiscoveredFile } from '../ingest/walk.js';
import type { ParseFailure, ParseReport, ParsedFile, SkippedFile } from '../types/symbols.js';

export interface ParseProgress {
  readonly filesParsed: number;
  readonly filesTotal: number;
  readonly currentFile: string;
}

export interface ParseRepositoryOptions {
  readonly files: readonly DiscoveredFile[];
  readonly onProgress?: (progress: ParseProgress) => void;
}

export async function parseRepository(
  options: ParseRepositoryOptions,
): Promise<Result<ParseReport, GrammarLoadError>> {
  const startedAt = Date.now();

  const created = await createSourceParser();
  if (!created.ok) {
    return created;
  }
  const parser = created.value;

  const files: ParsedFile[] = [];
  const failures: ParseFailure[] = [];
  const skipped: SkippedFile[] = [];

  try {
    for (const file of options.files) {
      await parseOne(parser, file, files, failures, skipped);
      options.onProgress?.({
        filesParsed: files.length,
        filesTotal: options.files.length,
        currentFile: file.path,
      });
    }
  } finally {
    parser.dispose();
  }

  return ok({ files, failures, skipped, durationMs: Date.now() - startedAt });
}

async function parseOne(
  parser: SourceParser,
  file: DiscoveredFile,
  files: ParsedFile[],
  failures: ParseFailure[],
  skipped: SkippedFile[],
): Promise<void> {
  if (!parser.supports(file.path)) {
    skipped.push({ path: file.path, language: file.language, reason: 'no-grammar-yet' });
    return;
  }

  const source = await readFile(file.absolutePath, 'utf8').catch((cause: unknown) => {
    failures.push({
      path: file.path,
      reason: 'unreadable',
      message: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  });
  if (source === null) {
    return;
  }

  const parsed = parser.parse({ path: file.path, source });
  if (parsed.ok) {
    files.push(parsed.value);
  } else {
    failures.push(parsed.error);
  }
}

export interface ParseSummary {
  readonly filesParsed: number;
  readonly filesSkipped: number;
  readonly filesFailed: number;
  /** Parsed files that contained recoverable syntax errors. */
  readonly filesWithSyntaxErrors: number;
  readonly importCount: number;
  readonly exportCount: number;
  readonly durationMs: number;
}

export function summariseParse(report: ParseReport): ParseSummary {
  let importCount = 0;
  let exportCount = 0;
  let filesWithSyntaxErrors = 0;

  for (const file of report.files) {
    importCount += file.imports.length;
    exportCount += file.exports.length;
    if (file.hadSyntaxErrors) {
      filesWithSyntaxErrors += 1;
    }
  }

  return {
    filesParsed: report.files.length,
    filesSkipped: report.skipped.length,
    filesFailed: report.failures.length,
    filesWithSyntaxErrors,
    importCount,
    exportCount,
    durationMs: report.durationMs,
  };
}
