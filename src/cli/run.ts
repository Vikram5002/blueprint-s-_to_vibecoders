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
import { writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { renderBlueprintSpec, blueprintConstraintsJson } from '../blueprint/spec.js';
import { createBlueprintStore } from '../store/blueprint-store.js';
import type { CompileBlueprintResult } from '../blueprint/dsl.js';

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

  /**
   * MCP starts serving *before* the pipeline runs.
   *
   * A real MCP host times the connection — the official Inspector gives up
   * after 15 seconds — and analysing first meant the handshake never arrived
   * on any repository big enough to be worth analysing. The handshake needs no
   * analysis, so it is answered immediately while the pipeline runs alongside.
   */
  if (options.mcp) {
    return await runMcp(options, io, version);
  }

  const run = await runPipeline({
    root: options.targetPath,
    ...(options.blueprintFile === null ? {} : { blueprintFile: options.blueprintFile }),
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

  const { analysis, labels, correctionOutcomes, intent, conformance, db, store, blueprintCompile } = run.value;
  const { walk: result, ingest: summary, parse, parseSummary, graph, clustering } = analysis;

  if (blueprintCompile !== null) {
    const written = await writeBlueprintOutputs(result.root, blueprintCompile);
    for (const file of written) io.writeErr(`  wrote ${file.path} (${file.bytes} bytes)`);
    io.writeErr(
      `  Blueprint: ${blueprintCompile.constraints.length} constraint(s) compiled, ` +
        `${blueprintCompile.rejected.length} line(s) rejected`,
    );
    for (const rejection of blueprintCompile.rejected) {
      io.writeErr(`    line ${rejection.line} (${rejection.reason}): ${rejection.text}`);
    }
  }

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
    blueprintStore: createBlueprintStore(db),
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

interface WrittenFile {
  readonly path: string;
  readonly bytes: number;
}

/**
 * Part B: the two agent-consumable outputs from one compiled blueprint,
 * written into `.vibe/` alongside the database rather than into the
 * repository proper — unlike `--export`'s AGENTS.md/blueprint.html, these are
 * not meant to be committed, they are regenerated from the DSL file on every
 * `--blueprint` run.
 */
async function writeBlueprintOutputs(root: string, compiled: CompileBlueprintResult): Promise<WrittenFile[]> {
  const dir = posix.join(root.replace(/\\/g, '/'), '.vibe');
  const specPath = posix.join(dir, 'blueprint-spec.md');
  const jsonPath = posix.join(dir, 'blueprint-constraints.json');

  const spec = renderBlueprintSpec(compiled.constraints, compiled.rejected);
  const json = blueprintConstraintsJson(compiled.constraints);

  await writeFile(specPath, spec, 'utf8');
  await writeFile(jsonPath, json, 'utf8');

  return [
    { path: specPath, bytes: Buffer.byteLength(spec, 'utf8') },
    { path: jsonPath, bytes: Buffer.byteLength(json, 'utf8') },
  ];
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

/**
 * The MCP path: serve first, analyse in parallel.
 *
 * Kept as its own function because it inverts the order of everything else in
 * this file — the transport comes up before the work does. Still no business
 * logic here (rule 5): it starts the pipeline, hands the resulting context to
 * the server, and formats nothing.
 */
async function runMcp(
  options: { readonly targetPath: string; readonly exportFiles: boolean; readonly blueprintFile: string | null },
  io: CliIo,
  version: string,
): Promise<number> {
  io.writeErr(`vibe-blueprint ${version}`);
  io.writeErr('Serving MCP on stdio. No port is open.');

  /**
   * Started immediately and memoised, so the analysis is usually finished
   * before an agent asks its first real question — but never blocks the
   * handshake, which is what a host is timing.
   */
  const analysis = (async () => {
    const run = await runPipeline({
      root: options.targetPath,
      ...(options.blueprintFile === null ? {} : { blueprintFile: options.blueprintFile }),
    });
    if (!run.ok) throw new Error(run.error.message);

    const { analysis: parsed, labels, correctionOutcomes, intent, conformance, db, store, blueprintCompile } =
      run.value;

    if (blueprintCompile !== null) {
      const written = await writeBlueprintOutputs(parsed.walk.root, blueprintCompile);
      for (const file of written) io.writeErr(`  wrote ${file.path} (${file.bytes} bytes)`);
    }

    const context = {
      root: parsed.walk.root,
      graph: parsed.graph,
      ingest: parsed.ingest,
      parse: parsed.parseSummary,
      parseFailures: parsed.parse.failures,
      clustering: parsed.clustering,
      labels,
      correctionOutcomes,
      intent,
      conformance,
      store,
      db,
      blueprintStore: createBlueprintStore(db),
    };

    if (options.exportFiles) {
      const written = await writeExports(context, {
        generatedAt: new Date().toISOString(),
        commit: await currentCommit(context.root),
      });
      for (const file of written) io.writeErr(`  wrote ${file.path} (${file.bytes} bytes)`);
    }

    io.writeErr(`  Ready: ${parsed.clustering.modules.length} module(s), ${parsed.graph.graph.order} file(s).`);
    return context;
  })();

  /**
   * A rejection here would otherwise be an unhandled promise before the first
   * tool call arrives. Swallowed at this level and re-thrown to whichever tool
   * call awaits it, which turns a crash into an error result the agent can act
   * on.
   */
  analysis.catch(() => undefined);

  await serveMcp(() => analysis, {
    input: process.stdin,
    write: (line) => process.stdout.write(`${line}
`),
  });

  // Closed off the resolved context rather than a captured handle, so a
  // pipeline that never finished leaves nothing to close.
  await analysis.then((context) => context.db.close()).catch(() => undefined);
  return EXIT_OK;
}
