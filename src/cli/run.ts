/**
 * Command orchestration: parse arguments, call the pipeline, format output.
 * Nothing else lives here (CLAUDE.md rule 5).
 */
import { parseArguments } from './args.js';
import {
  formatError,
  formatFileList,
  formatHelp,
  formatJson,
  formatProgress,
  formatSummary,
} from './output.js';
import { walkRepository } from '../ingest/walk.js';
import { summariseWalk } from '../ingest/summary.js';

export interface CliIo {
  readonly writeOut: (line: string) => void;
  readonly writeErr: (line: string) => void;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export async function runCli(argv: readonly string[], io: CliIo, version: string): Promise<number> {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    io.writeErr(formatError(parsed.error.message));
    io.writeErr(formatHelp('vibe-blueprint'));
    return EXIT_USAGE;
  }

  const options = parsed.value;
  if (options.help) {
    io.writeOut(formatHelp('vibe-blueprint'));
    return EXIT_OK;
  }
  if (options.version) {
    io.writeOut(version);
    return EXIT_OK;
  }

  const showProgress = options.verbose && !options.json;
  if (!options.json) {
    io.writeErr(`vibe-blueprint ${version}`);
    io.writeErr(`Scanning ${options.targetPath}`);
  }

  const walked = await walkRepository({
    root: options.targetPath,
    ...(showProgress
      ? {
          onProgress: (progress) =>
            io.writeErr(
              formatProgress(progress.directoriesVisited, progress.filesFound, progress.currentDirectory),
            ),
        }
      : {}),
  });

  if (!walked.ok) {
    io.writeErr(formatError(walked.error.message));
    return EXIT_FAILURE;
  }

  const result = walked.value;
  const summary = summariseWalk(result);

  if (options.json) {
    io.writeOut(formatJson(summary, result.files, result.stats.errors));
    return EXIT_OK;
  }

  if (options.verbose && result.files.length > 0) {
    io.writeOut(formatFileList(result.files));
  }
  io.writeOut(formatSummary(summary, result.stats.errors));

  return EXIT_OK;
}
