/**
 * Command orchestration: parse arguments, call the pipeline, format output.
 * Nothing else lives here (CLAUDE.md rule 5).
 */
import { parseArguments } from './args.js';
import {
  formatClusterSummary,
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
import { analyseRepository } from '../pipeline/analyse.js';
import { startServer, type RunningServer } from '../server/server.js';

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

  const analysed = await analyseRepository({
    root: options.targetPath,
    ...(showProgress
      ? {
          onProgress: (progress) =>
            io.writeErr(
              progress.stage === 'walk'
                ? formatProgress(progress.directoriesVisited, progress.filesFound, progress.currentDirectory)
                : formatParseProgress(progress.filesParsed, progress.filesTotal, progress.currentFile),
            ),
        }
      : {}),
  });

  if (!analysed.ok) {
    io.writeErr(formatError(analysed.error.message));
    return EXIT_FAILURE;
  }

  const { walk: result, ingest: summary, parse, parseSummary, graph, clustering } = analysed.value;

  if (options.json) {
    io.writeOut(
      formatJson(summary, result.files, result.stats.errors, parseSummary, parse, graph, clustering),
    );
    return EXIT_OK;
  }

  if (options.verbose && result.files.length > 0) {
    io.writeOut(formatFileList(result.files));
  }
  io.writeOut(formatSummary(summary, result.stats.errors));
  io.writeOut(formatParseSummary(parseSummary, parse.failures));
  io.writeOut(formatGraphSummary(graph));
  io.writeOut(formatClusterSummary(clustering));

  if (!options.serve) {
    return EXIT_OK;
  }

  const server = await startServer({
    root: result.root,
    graph,
    ingest: summary,
    parse: parseSummary,
    parseFailures: parse.failures,
    clustering,
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
