/**
 * Terminal formatting. Pure string production — callers do the writing.
 * No business logic (CLAUDE.md rule 5).
 */
import type { DiscoveredFile, WalkError } from '../ingest/walk.js';
import type { IngestSummary } from '../ingest/summary.js';
import type { Language } from '../ingest/language.js';

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
    '  --json           Emit machine-readable JSON on stdout',
    '  -v, --verbose    Print progress lines and the full file list',
    '  --no-open        Do not open a browser (no effect until the server lands)',
    '  -h, --help       Show this help',
    '      --version    Show the version',
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

export function formatJson(summary: IngestSummary, files: readonly DiscoveredFile[], errors: readonly WalkError[]): string {
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
