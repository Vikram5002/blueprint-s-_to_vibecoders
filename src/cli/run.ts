/**
 * Command orchestration: parse arguments, call the pipeline, format output.
 * Nothing else lives here (CLAUDE.md rule 5).
 */
import { parseArguments } from './args.js';
import {
  formatClusterSummary,
  formatCorrectionSummary,
  formatError,
  formatLabelSummary,
  formatIntentSummary,
  formatConformanceSummary,
  formatDriftHistory,
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
import { chooseProvider } from '../llm/select-provider.js';
import { runPipeline } from '../pipeline/run.js';
import { snapshotHistory } from '../pipeline/history.js';
import { buildDriftHistory } from '../pipeline/drift-history.js';
import { createSnapshotStore } from '../store/snapshots.js';
import { startServer, type RunningServer } from '../server/server.js';
import { serveMcp } from '../mcp/server.js';
import { writeExports, currentCommit } from '../export/write.js';

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

  const run = await runPipeline({
    root: options.targetPath,
    ...(showProgress
      ? {
          onProgress: (progress) =>
            io.writeErr(
              progress.stage === 'walk'
                ? formatProgress(progress.directoriesVisited, progress.filesFound, progress.currentDirectory)
                : formatParseProgress(progress.filesParsed, progress.filesTotal, progress.currentFile),
            ),
          onLabelProgress: (done, total, moduleId) => io.writeErr(`  named ${done}/${total} — ${moduleId}`),
          onIntentProgress: (done, total, location) => io.writeErr(`  read ${done}/${total} — ${location}`),
        }
      : {}),
  });

  if (!run.ok) {
    io.writeErr(formatError(run.error.message));
    return EXIT_FAILURE;
  }

  const { analysis, labels, correctionOutcomes, intent, conformance, db, store } = run.value;
  const { walk: result, ingest: summary, parse, parseSummary, graph, clustering } = analysis;

  if (options.json) {
    io.writeOut(
      formatJson(
        summary,
        result.files,
        result.stats.errors,
        parseSummary,
        parse,
        graph,
        clustering,
        labels,
        intent,
        conformance,
      ),
    );
    db.close();
    return EXIT_OK;
  }

  const analysisContext = {
    root: result.root,
    graph,
    ingest: summary,
    parse: parseSummary,
    parseFailures: parse.failures,
    clustering,
    labels,
    correctionOutcomes,
    intent,
    conformance,
    store,
    db,
  };

  /**
   * Exports are written before the MCP branch, so `--mcp --export` produces
   * both. Progress goes to stderr because stdout may already belong to the
   * protocol.
   */
  if (options.exportFiles) {
    const written = await writeExports(analysisContext, {
      generatedAt: new Date().toISOString(),
      commit: await currentCommit(result.root),
    });
    for (const file of written) io.writeErr(`  wrote ${file.path} (${file.bytes} bytes)`);
  }

  /**
   * MCP owns stdout from here on.
   *
   * Placed above every other `writeOut` deliberately: in this mode stdout is a
   * JSON-RPC transport, and one summary line written before the loop starts
   * would be read by the client as a malformed message. Progress and errors
   * still reach stderr, which MCP clients ignore.
   */
  if (options.mcp) {
    io.writeErr('Serving MCP on stdio. No port is open.');
    await serveMcp(analysisContext, {
      input: process.stdin,
      write: (line) => process.stdout.write(`${line}\n`),
    });
    db.close();
    return EXIT_OK;
  }

  if (options.verbose && result.files.length > 0) {
    io.writeOut(formatFileList(result.files));
  }
  io.writeOut(formatSummary(summary, result.stats.errors));
  io.writeOut(formatParseSummary(parseSummary, parse.failures));
  io.writeOut(formatGraphSummary(graph));
  io.writeOut(formatClusterSummary(clustering));
  io.writeOut(formatLabelSummary(labels, chooseProvider().keyEnv));
  io.writeOut(formatCorrectionSummary(correctionOutcomes));
  io.writeOut(formatIntentSummary(intent));
  io.writeOut(formatConformanceSummary(conformance));

  /**
   * History is opt-in because it costs a worktree and a full re-analysis per
   * commit. Snapshots are persisted as they are built, so an interrupted walk
   * leaves the commits it did finish available to the next run.
   */
  if (options.history !== null) {
    const snapshotStore = createSnapshotStore(db);
    io.writeErr(`  Snapshotting the last ${options.history} commits…`);

    const snapshots = await snapshotHistory({
      root: options.targetPath,
      count: options.history,
      corrections: run.value.corrections,
      constraints: intent.constraints,
      onProgress: (done, total, commit) =>
        io.writeErr(`  snapshot ${done}/${total} — ${commit.sha.slice(0, 7)} ${commit.subject.slice(0, 50)}`),
    });

    for (const snapshot of snapshots) snapshotStore.save(snapshot);
    io.writeOut(formatDriftHistory(buildDriftHistory(snapshots)));
  }

  if (!options.serve) {
    db.close();
    return EXIT_OK;
  }

  const server = await startServer(analysisContext);

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
