/**
 * Command orchestration: parse arguments, call the pipeline, format output.
 * Nothing else lives here (CLAUDE.md rule 5).
 */
import { parseArguments } from './args.js';
import {
  formatError,
  formatFileList,
  formatGraphSummary,
  formatHelp,
  formatJson,
  formatParseProgress,
  formatParseSummary,
  formatProgress,
  formatServing,
  formatSummary,
} from './output.js';
import { openBrowser } from './open-browser.js';
import { resolveRepository } from '../graph/resolve.js';
import { buildDependencyGraph } from '../graph/build-graph.js';
import { startServer, type RunningServer } from '../server/server.js';
import { walkRepository } from '../ingest/walk.js';
import { summariseWalk } from '../ingest/summary.js';
import { parseRepository, summariseParse } from '../parser/parse-repository.js';

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

  const parseResult = await parseRepository({
    files: result.files,
    ...(showProgress
      ? {
          onProgress: (progress) =>
            io.writeErr(formatParseProgress(progress.filesParsed, progress.filesTotal, progress.currentFile)),
        }
      : {}),
  });

  if (!parseResult.ok) {
    io.writeErr(formatError(parseResult.error.message));
    return EXIT_FAILURE;
  }

  const parseSummary = summariseParse(parseResult.value);

  const resolution = await resolveRepository({ root: result.root, files: parseResult.value.files });
  const graph = buildDependencyGraph({ files: parseResult.value.files, resolution });

  if (options.json) {
    io.writeOut(formatJson(summary, result.files, result.stats.errors, parseSummary, parseResult.value, graph));
    return EXIT_OK;
  }

  if (options.verbose && result.files.length > 0) {
    io.writeOut(formatFileList(result.files));
  }
  io.writeOut(formatSummary(summary, result.stats.errors));
  io.writeOut(formatParseSummary(parseSummary, parseResult.value.failures));
  io.writeOut(formatGraphSummary(graph));

  if (!options.serve) {
    return EXIT_OK;
  }

  const server = await startServer({
    root: result.root,
    graph,
    ingest: summary,
    parse: parseSummary,
    parseFailures: parseResult.value.failures,
  });

  io.writeOut(formatServing(server.url, options.open));
  if (options.open) {
    openBrowser(server.url);
  }

  await waitForShutdown(server, io);
  return EXIT_OK;
}

/**
 * Holds the process open until Ctrl+C, then closes the listener so the port is
 * released rather than left to the OS on exit.
 */
async function waitForShutdown(server: RunningServer, io: CliIo): Promise<void> {
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      io.writeErr('');
      io.writeErr('Shutting down.');
      void server.close().then(resolve, resolve);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
