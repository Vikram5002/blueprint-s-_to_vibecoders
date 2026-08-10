/**
 * Terminal formatting. Pure string production — callers do the writing.
 * No business logic (CLAUDE.md rule 5).
 */
import type { DiscoveredFile, WalkError } from '../ingest/walk.js';
import type { IngestSummary } from '../ingest/summary.js';
import type { Language } from '../ingest/language.js';
import type { ParseSummary } from '../parser/parse-repository.js';
import type { ParseFailure, ParseReport } from '../types/symbols.js';
import type { ResolutionSummary } from '../types/resolution.js';
import type { DependencyGraph } from '../graph/build-graph.js';
import type { ClusteringResult } from '../types/modules.js';
import type { LabelSet } from '../types/labels.js';
import type { CorrectionOutcome } from '../types/corrections.js';
import type { IntentRunResult } from '../pipeline/intent.js';
import type { ConformanceResult } from '../types/violations.js';
import type { DriftHistory } from '../pipeline/drift-history.js';

const LANGUAGE_LABELS: Readonly<Record<Language, string>> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
};

export function formatHelp(binaryName: string): string {
  return [
    'vibe-blueprint — derive a codebase\'s actual architecture and measure it',
    '',
    `Usage: ${binaryName} [path] [options]`,
    '',
    'Arguments:',
    '  path             Repository to analyse (default: current directory)',
    '',
    'Options:',
    '  --json           Emit machine-readable JSON on stdout (implies --no-serve)',
    '  -v, --verbose    Print progress lines and the full file list',
    '  --no-open        Start the server but do not open a browser',
    '  --no-serve       Print the summary and exit; do not start the server',
    '  -h, --help       Show this help',
    '      --version    Show the version',
    '      --history=N  Snapshot the last N commits and chart drift over them',
    '',
    'Phase 1: ingest and parse. This tool measures. It never generates code.',
  ].join('\n');
}

export function formatSummary(summary: IngestSummary, errors: readonly WalkError[]): string {
  const lines = [
    '',
    `  Files to analyse    ${count(summary.fileCount)}`,
    ...languageBreakdown(summary),
    '',
    `  Ignored (gitignore) ${count(summary.filesIgnored)}`,
    `  Unsupported files   ${count(summary.filesUnsupported)}`,
    `  Directories skipped ${count(summary.directoriesSkipped)}`,
  ];

  if (summary.symlinksSkipped > 0) {
    lines.push(`  Symlinks skipped    ${count(summary.symlinksSkipped)}`);
  }
  if (errors.length > 0) {
    lines.push(`  Unreadable paths    ${count(errors.length)}`);
    lines.push(...errors.slice(0, 5).map((error) => `    ! ${error.message}`));
    if (errors.length > 5) {
      lines.push(`    ... and ${count(errors.length - 5)} more`);
    }
  }

  lines.push(
    '',
    `  Walked ${count(summary.entriesSeen)} entries across ${count(summary.directoriesVisited)} directories in ${formatDuration(summary.durationMs)}`,
    '',
  );

  return lines.join('\n');
}

export function formatProgress(directoriesVisited: number, filesFound: number, currentDirectory: string): string {
  const where = currentDirectory === '' ? '.' : currentDirectory;
  return `  scanned ${count(directoriesVisited)} dirs, ${count(filesFound)} files — ${where}`;
}

export function formatFileList(files: readonly DiscoveredFile[]): string {
  return files.map((file) => `  ${file.language.padEnd(10)} ${file.path}`).join('\n');
}

export function formatParseProgress(filesParsed: number, filesTotal: number, currentFile: string): string {
  return `  parsed ${count(filesParsed)}/${count(filesTotal)} — ${currentFile}`;
}

export function formatParseSummary(summary: ParseSummary, failures: readonly ParseFailure[]): string {
  const lines = [
    `  Files parsed        ${count(summary.filesParsed)}`,
    `    imports           ${count(summary.importCount)}`,
    `    exports           ${count(summary.exportCount)}`,
  ];

  if (summary.filesSkipped > 0) {
    lines.push(`  No extractor        ${count(summary.filesSkipped)}`);
  }
  if (summary.filesWithSyntaxErrors > 0) {
    lines.push(`  Syntax errors       ${count(summary.filesWithSyntaxErrors)}  (recovered, symbols are partial)`);
  }
  if (failures.length > 0) {
    lines.push(`  Failed to parse     ${count(failures.length)}`);
    lines.push(...failures.slice(0, 5).map((failure) => `    ! ${failure.path}: ${failure.message}`));
    if (failures.length > 5) {
      lines.push(`    ... and ${count(failures.length - 5)} more`);
    }
  }

  lines.push('', `  Parsed in ${formatDuration(summary.durationMs)}`, '');
  return lines.join('\n');
}

/**
 * Modularity is printed as a diagnostic, labelled as one. It says how sharply
 * the graph divides, not whether the division is right — there is no ground
 * truth for that — and it must not read as a quality score.
 */
export function formatClusterSummary(clustering: ClusteringResult): string {
  const { summary } = clustering;
  const lines = [
    `  Modules             ${count(summary.moduleCount)}  (Louvain over import coupling)`,
    `    from coupling     ${count(summary.byReason['import-coupling'])}  files`,
    `    from directory    ${count(summary.byReason['directory-prior'])}  files with no imports either way`,
    `    merged as small   ${count(summary.byReason['small-cluster-merge'])}  files in ${count(summary.mergedClusters)} clusters`,
    '',
    `  Coupling vs folders ${summary.disagreementRate.toFixed(1)}% of files disagree`,
    `    cross-directory   ${count(summary.crossDirectoryModules)} modules span more than one folder`,
    `    split directories ${count(summary.splitDirectories)} folders span more than one module`,
  ];

  if (clustering.disagreements.length > 0) {
    lines.push('');
    for (const example of clustering.disagreements.slice(0, 3)) {
      lines.push(`    e.g. ${example.file}`);
      lines.push(`         lives in ${example.directory}, grouped with ${example.modulePluralityDirectory}`);
    }
  }

  lines.push(
    '',
    `  Modularity ${summary.modularity.toFixed(3)} (diagnostic only, not a quality score)` +
      `  ·  resolution ${summary.resolution}  ·  seed ${summary.seed}  ·  min cluster ${summary.minClusterSize}`,
    '',
  );

  return lines.join('\n');
}

/**
 * Labelling. The no-key case says one quiet line and stops — a user who never
 * configures a key should not be nagged on every run.
 */
export function formatLabelSummary(labels: LabelSet, keyEnv = 'GEMINI_API_KEY'): string {
  const { summary } = labels;

  if (summary.degraded) {
    // Names the variable the *configured* provider reads, so the hint is
    // actionable when the default changes. Says nothing about the key's value.
    return [`  Module names        mechanical (no ${keyEnv} configured)`, ''].join('\n');
  }

  const lines = [
    `  Module names        ${count(summary.llmLabelled)} from ${summary.provider ?? 'a model'}` +
      `, ${count(summary.userCorrected)} yours, ${count(summary.mechanical)} mechanical`,
    `    cache             ${count(summary.cacheHits)} hits, ${count(summary.cacheMisses)} misses` +
      `  (${cacheRate(summary.cacheHits, summary.cacheMisses)})`,
    `    tokens            ${count(summary.usage.promptTokens)} in, ${count(summary.usage.completionTokens)} out` +
      `  ·  about $${summary.usage.estimatedCostUsd.toFixed(4)}`,
  ];

  if (summary.failures.length > 0) {
    lines.push(`    not named         ${count(summary.failures.length)} (kept their mechanical name)`);
    for (const failure of summary.failures.slice(0, 3)) {
      lines.push(`      ! ${failure.moduleId}: ${failure.reason}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function cacheRate(hits: number, misses: number): string {
  const total = hits + misses;
  return total === 0 ? 'nothing to do' : `${((hits / total) * 100).toFixed(0)}% hit rate`;
}

/**
 * Correction outcomes. Drift and orphans are printed in full rather than
 * summarised — a correction that quietly stopped matching is exactly the thing
 * a user needs told.
 */
export function formatCorrectionSummary(outcomes: readonly CorrectionOutcome[]): string {
  if (outcomes.length === 0) {
    return '';
  }

  const applied = outcomes.filter((outcome) => outcome.status === 'applied');
  const drifted = outcomes.filter((outcome) => outcome.status === 'applied-with-drift');
  const orphaned = outcomes.filter((outcome) => outcome.status === 'orphaned');

  const lines = [
    `  Your corrections    ${count(outcomes.length)}  ` +
      `(${count(applied.length)} applied, ${count(drifted.length)} with drift, ${count(orphaned.length)} orphaned)`,
  ];

  for (const outcome of drifted) {
    lines.push('', `    drift  ${outcome.kind} on ${outcome.moduleId ?? '(unknown)'}`);
    lines.push(`           ${outcome.explanation}`);
    for (const file of outcome.joined.slice(0, 5)) {
      lines.push(`           + ${file}`);
    }
    for (const file of outcome.left.slice(0, 5)) {
      lines.push(`           - ${file}`);
    }
  }

  for (const outcome of orphaned) {
    lines.push('', `    orphan ${outcome.kind}  ${outcome.explanation}`);
  }

  const unresolved = outcomes.flatMap((outcome) => outcome.unresolved);
  if (unresolved.length > 0) {
    lines.push('', `    ${count(unresolved.length)} file(s) belong to neither side of a split and were left alone:`);
    for (const file of unresolved.slice(0, 5)) {
      lines.push(`           ? ${file}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Stated intent.
 *
 * Written to keep STATED visibly apart from everything above it in the report.
 * Every other section describes what the code does; this one describes what
 * somebody claimed, and the wording says so — "claims", "stated", and the file
 * and line behind each one. Week 8 is what compares them.
 */
export function formatIntentSummary(intent: IntentRunResult): string {
  const { summary } = intent;
  if (summary.degraded) {
    return summary.documents === 0
      ? ''
      : [
          `  Stated intent       ${count(summary.documents)} document(s) found, not read`,
          '                      (no ANTHROPIC_API_KEY — reading prose needs a model, and there',
          '                       is no mechanical fallback, so this is "not attempted", not "none")',
          '',
        ].join('\n');
  }

  const complete = summary.documents - summary.incompleteDocuments;
  const lines = [
    `  Stated intent       ${count(summary.constraints)} constraint(s) from ` +
      `${count(complete)} of ${count(summary.documents)} document(s)`,
  ];

  /**
   * Incompleteness is stated before the counts, not after them.
   *
   * A truncated document contributes zero constraints, so the headline number
   * is a floor rather than a result — and printing it plainly would invite the
   * reader to treat it as final. This happened for real on this project's own
   * CLAUDE.md: the run reported zero constraints from a document that states
   * three, and the only clue was a "documents not read" line further down.
   */
  if (summary.incompleteDocuments > 0) {
    lines.unshift(
      `  !! EXTRACTION INCOMPLETE — ${count(summary.incompleteDocuments)} document(s) were cut off`,
      '     at the output token limit and contributed nothing. The counts below are a',
      '     floor, not a result: treat them as unmeasured for those documents.',
      '',
    );
  }

  for (const [relation, total] of Object.entries(summary.byRelation)) {
    if (total > 0) lines.push(`    ${relation.padEnd(20)}${count(total)}`);
  }

  if (summary.uncheckable > 0) {
    lines.push(
      '',
      `  Architectural but uncheckable  ${count(summary.uncheckable)}`,
      '    Said about the architecture, but not decidable from an import graph.',
    );
    for (const [reason, total] of Object.entries(summary.byUncheckableReason)) {
      if (total > 0) lines.push(`    ${reason.padEnd(28)}${count(total)}`);
    }
  }

  if (summary.constraints > 0) {
    // Reported separately from extraction on purpose: a constraint that was
    // read correctly but whose subject could not be found is a different
    // failure from one that was never read, and averaging them hides both.
    lines.push(
      '',
      `  Subject resolution  ${summary.subjects.resolutionRate.toFixed(1)}%  ` +
        `(${count(summary.subjects.module)} module, ${count(summary.subjects.pathPattern)} path, ` +
        `${count(summary.subjects.unresolved)} unresolved)`,
    );
    for (const [reason, total] of Object.entries(summary.subjects.byReason)) {
      if (total > 0) lines.push(`    ${reason.padEnd(20)}${count(total)}`);
    }
    lines.push(
      '',
      `  Evaluable in Week 8 ${count(summary.evaluable)} of ${count(summary.constraints)}`,
      `  Low confidence      ${count(summary.lowConfidence)}`,
    );
  }

  if (intent.failures.length > 0) {
    lines.push('', `  Documents not read  ${count(intent.failures.length)}`);
    for (const failure of intent.failures.slice(0, 3)) {
      lines.push(`    ${failure.location}: ${failure.reason}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Conformance.
 *
 * Leads with what was checked, not with what failed. A violation count on its
 * own is unreadable — zero could mean a clean repository or a repository whose
 * every rule was unevaluable, and those are opposite findings.
 */
export function formatConformanceSummary(conformance: ConformanceResult): string {
  const { summary } = conformance;
  if (summary.constraints === 0) {
    return '';
  }

  const lines = [
    `  Conformance         ${count(summary.checked)} of ${count(summary.constraints)} constraint(s) checked`,
  ];

  if (summary.unchecked > 0) {
    lines.push(`    not checkable     ${count(summary.unchecked)}`);
    for (const [reason, total] of Object.entries(summary.byUncheckedReason)) {
      if (total > 0) lines.push(`      ${reason.padEnd(18)}${count(total)}`);
    }
  }

  if (summary.violations === 0) {
    // The good case, stated as a result rather than as an absence of output.
    lines.push(
      `    satisfied         ${count(summary.satisfied)}`,
      '',
      '  No violations. Every rule that could be checked, holds.',
      '',
    );
    return lines.join('\n');
  }

  lines.push(
    `    satisfied         ${count(summary.satisfied)}`,
    `    violated          ${count(summary.violated)}`,
    '',
    `  Violations          ${count(summary.violations)}  ` +
      `(${count(summary.bySeverity.high)} high, ${count(summary.bySeverity.medium)} medium, ` +
      `${count(summary.bySeverity.low)} low)  across ${count(summary.implicatedEdges)} edge(s)`,
  );

  // Highest severity first, then by score, so the worst thing is at the top.
  const ranked = [...conformance.violations].sort(
    (a, b) => b.severityScore - a.severityScore || a.id.localeCompare(b.id),
  );

  for (const violation of ranked.slice(0, 5)) {
    lines.push('', `    [${violation.severity}] ${violation.explanation}`);
    lines.push(`           rule: "${truncate(violation.constraint.rawText, 96)}"`);
    lines.push(
      `           from: ${violation.constraint.source.location}` +
        (violation.constraint.source.line === null ? '' : `:${violation.constraint.source.line}`),
    );
    // Rule 3 one level up: point at the import line, not just the file.
    for (const edge of violation.edges.slice(0, 3)) {
      const first = edge.evidence[0];
      if (first === undefined) continue;
      lines.push(`           ${first.file}:${first.line}  ${truncate(first.snippet.trim(), 72)}`);
    }
    if (violation.edges.length > 3) {
      lines.push(`           … and ${count(violation.edges.length - 3)} more edge(s)`);
    }
  }

  if (ranked.length > 5) {
    lines.push('', `    … and ${count(ranked.length - 5)} more violation(s)`);
  }

  lines.push('');
  return lines.join('\n');
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

export function formatServing(url: string, opening: boolean): string {
  return [
    `  Blueprint ready at  ${url}`,
    opening ? '  Opening your browser…' : '  (browser not opened)',
    '',
    '  Click an edge to see the source lines behind it. Ctrl+C to stop.',
    '',
  ].join('\n');
}

export function formatGraphSummary(graph: DependencyGraph): string {
  const { summary } = graph;
  const lines = [
    `  Graph               ${count(graph.graph.order)} nodes, ${count(graph.graph.size)} edges`,
    `  Imports             ${count(summary.total)}`,
    `    internal          ${count(summary.internal)}`,
    `    external          ${count(summary.external)}${externalDetail(summary)}`,
    `    unresolved        ${count(summary.unresolved)}`,
    '',
    `  Resolution rate     ${summary.resolutionRate.toFixed(1)}%`,
  ];

  if (summary.unresolved > 0) {
    lines.push('', '  Unresolved by reason');
    for (const [reason, total] of sortedReasons(summary.unresolvedByReason)) {
      lines.push(`    ${reason.padEnd(24)}${count(total)}`);
    }
    lines.push(...unresolvedExamples(graph));
  }

  lines.push('');
  return lines.join('\n');
}

/** A handful of real cases makes a reason code actionable rather than abstract. */
function unresolvedExamples(graph: DependencyGraph): string[] {
  const seen = new Set<string>();
  const examples: string[] = [];

  for (const item of graph.unresolved) {
    if (seen.has(item.reason) || examples.length >= 3) {
      continue;
    }
    seen.add(item.reason);
    examples.push(`    e.g. ${item.specifier}  (${item.evidence.file}:${item.evidence.line})`);
  }

  return examples.length === 0 ? [] : ['', ...examples];
}

function externalDetail(summary: ResolutionSummary): string {
  const parts = sortedReasons(summary.externalByReason).map(([reason, total]) => `${reason} ${count(total)}`);
  return parts.length === 0 ? '' : `  (${parts.join(', ')})`;
}

function sortedReasons(counts: Readonly<Partial<Record<string, number>>>): [string, number][] {
  return Object.entries(counts)
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .sort((a, b) => b[1] - a[1]);
}

export function formatJson(
  summary: IngestSummary,
  files: readonly DiscoveredFile[],
  errors: readonly WalkError[],
  parseSummary: ParseSummary,
  report: ParseReport,
  graph: DependencyGraph,
  clustering: ClusteringResult,
  labels: LabelSet,
  intent: IntentRunResult,
  conformance: ConformanceResult,
): string {
  return JSON.stringify(
    {
      root: summary.root,
      files: files.map((file) => ({
        path: file.path,
        language: file.language,
        sizeBytes: file.sizeBytes,
      })),
      summary,
      errors,
      parse: {
        summary: parseSummary,
        failures: report.failures,
        skipped: report.skipped,
        files: report.files,
      },
      graph: {
        summary: graph.summary,
        nodes: graph.graph.mapNodes((_id, attributes) => attributes),
        edges: graph.graph.mapEdges((_id, attributes, source, target) => ({
          from: source,
          to: target,
          ...attributes,
        })),
        externals: graph.externals,
        unresolved: graph.unresolved,
      },
      clustering: {
        summary: clustering.summary,
        modules: clustering.modules,
        edges: clustering.edges.map((edge) => ({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          weight: edge.weight,
          importCount: edge.importCount,
          provenance: edge.provenance,
        })),
        assignments: clustering.assignments,
        disagreements: clustering.disagreements,
        merges: clustering.merges,
        correctionOutcomes: clustering.correctionOutcomes,
      },
      labelling: {
        summary: labels.summary,
        labels: [...labels.labels.values()],
      },
      // Kept in its own key, never folded into `graph` or `clustering`.
      // Rule 2: a consumer must not be able to read a claim as a fact.
      intent: {
        summary: intent.summary,
        constraints: intent.constraints,
        uncheckable: intent.uncheckable,
        failures: intent.failures,
        usage: intent.usage,
      },
      // A comparison of the two halves, and its own key for the same reason:
      // a violation is neither a fact about the code nor a claim on its own.
      conformance: {
        summary: conformance.summary,
        violations: conformance.violations,
        unchecked: conformance.unchecked,
      },
    },
    null,
    2,
  );
}

export function formatError(message: string): string {
  return `vibe-blueprint: ${message}`;
}

function languageBreakdown(summary: IngestSummary): string[] {
  return (Object.keys(LANGUAGE_LABELS) as Language[])
    .filter((language) => summary.byLanguage[language] > 0)
    .map((language) => `    ${LANGUAGE_LABELS[language].padEnd(16)}${count(summary.byLanguage[language])}`);
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}

/**
 * The drift chart.
 *
 * A sparkline plus the cause of every move. Week 5's standard for the
 * clustering metrics applies here too: a number nobody can interrogate is a
 * number nobody should trust, so no point on this chart appears without the
 * diff entries that produced it.
 */
export function formatDriftHistory(history: DriftHistory): string {
  const { points, summary } = history;
  if (points.length === 0) {
    return '  Drift history       no commits analysed\n';
  }

  const peak = Math.max(summary.peak, 1);
  const lines = [
    `  Drift history       ${count(summary.commits)} commits, ` +
      `score ${summary.first.toFixed(1)} → ${summary.last.toFixed(1)} ` +
      `(peak ${summary.peak.toFixed(1)})`,
    '',
  ];

  for (const point of points) {
    // Eight blocks is enough resolution for a terminal and avoids implying a
    // precision the score does not have.
    const filled = summary.peak === 0 ? 0 : Math.round((point.score / peak) * 8);
    const bar = '#'.repeat(filled).padEnd(8, '·');
    const delta = point.delta === 0 ? '     ' : `${point.delta > 0 ? '+' : ''}${point.delta.toFixed(1)}`;

    lines.push(
      `    ${point.shortCommit}  ${bar}  ${point.score.toFixed(1).padStart(6)}  ${delta.padStart(6)}  ` +
        `${String(point.fileCount).padStart(4)}f ${String(point.moduleCount).padStart(3)}m ` +
        `${String(point.changeCount).padStart(3)}Δ  ${truncate(point.subject, 46)}`,
    );

    for (const cause of point.causes.slice(0, 3)) {
      lines.push(`              ↳ ${truncate(cause, 92)}`);
    }
  }

  lines.push(
    '',
    `    ${count(summary.movingSteps)} step(s) moved the score, ` +
      `${count(summary.structuralOnlySteps)} changed the architecture without moving it.`,
    `    ${summary.note}`,
    '',
  );

  return lines.join('\n');
}
