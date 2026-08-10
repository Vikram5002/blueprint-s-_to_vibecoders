/**
 * Finding the documents that state a repository's intended architecture.
 *
 * Deterministic and offline. This module reads files and splits them into
 * candidate statements; it decides nothing about what they mean. Keeping
 * discovery separate from extraction is what lets the expensive half be cached
 * and the cheap half be tested exhaustively.
 *
 * Rule 6 is respected trivially — the only I/O here is reading files and asking
 * git for commit subjects.
 */
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import type { ConstraintSource, ConstraintSourceType } from '../types/constraints.js';

/** Documents above this are truncated; see TRUNCATION below. */
export const MAX_DOCUMENT_CHARS = 24_000;

/** Commit subjects scanned. Enough to cover recent intent without paging history. */
export const MAX_COMMITS = 200;

export interface IntentDocument {
  readonly type: ConstraintSourceType;
  /** Repo-relative path, or `commit:<sha>` / `chat:<id>`. */
  readonly location: string;
  readonly timestamp: string | null;
  readonly text: string;
  /** True when the body was cut at MAX_DOCUMENT_CHARS. */
  readonly truncated: boolean;
}

export interface Statement {
  readonly text: string;
  readonly source: ConstraintSource;
}

/**
 * Filenames that state intent, in the order they are trusted.
 *
 * AGENTS.md and CLAUDE.md come first deliberately. They are written *to* a
 * machine, so they tend to state rules as rules — "never import X from Y" —
 * where a README states them as description. That makes them both the richest
 * source of checkable constraints and the most likely to be current, since a
 * stale one produces visibly wrong agent behaviour.
 */
const NAMED_SOURCES: readonly (readonly [RegExp, ConstraintSourceType])[] = [
  [/^AGENTS\.md$/i, 'agents-md'],
  [/^CLAUDE\.md$/i, 'agents-md'],
  [/^\.cursorrules$/i, 'agents-md'],
  [/^README(\.md|\.rst|\.txt)?$/i, 'readme'],
  [/^ARCHITECTURE\.md$/i, 'readme'],
  [/^CONTRIBUTING\.md$/i, 'readme'],
];

/** Directories that hold architecture decision records. */
const ADR_DIRECTORIES = ['docs/adr', 'docs/adrs', 'docs/decisions', 'adr', 'architecture/decisions'];

export interface DiscoverOptions {
  readonly root: string;
  /** Injected in tests. Defaults to reading real commit subjects. */
  readonly commitSubjects?: readonly { readonly sha: string; readonly subject: string; readonly date: string }[];
  /** Chat transcripts already parsed; see chat-log.ts for the supported format. */
  readonly chatMessages?: readonly IntentDocument[];
}

export async function discoverIntentDocuments(options: DiscoverOptions): Promise<IntentDocument[]> {
  const documents: IntentDocument[] = [];

  const rootEntries = await readdir(options.root, { withFileTypes: true }).catch(() => []);
  for (const entry of rootEntries) {
    if (!entry.isFile()) continue;
    const match = NAMED_SOURCES.find(([pattern]) => pattern.test(entry.name));
    if (match === undefined) continue;
    const document = await readDocument(options.root, entry.name, match[1]);
    if (document !== null) documents.push(document);
  }

  for (const directory of ADR_DIRECTORIES) {
    const absolute = join(options.root, ...directory.split('/'));
    const info = await stat(absolute).catch(() => null);
    if (info === null || !info.isDirectory()) continue;
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(md|txt|rst)$/i.test(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      const document = await readDocument(options.root, path, 'adr');
      if (document !== null) documents.push(document);
    }
  }

  for (const commit of options.commitSubjects ?? []) {
    documents.push({
      type: 'commit-msg',
      location: `commit:${commit.sha}`,
      timestamp: commit.date,
      text: commit.subject,
      truncated: false,
    });
  }

  documents.push(...(options.chatMessages ?? []));

  // Sorted so a run does not depend on directory iteration order.
  return documents.sort((a, b) => a.location.localeCompare(b.location));
}

/**
 * Removes this tool's own generated export block before reading a document.
 *
 * `--export` writes a measured summary into AGENTS.md, and AGENTS.md is one of
 * the documents intent extraction reads. Without this, the second run reads
 * the first run's output as freshly stated intent: the tool measures itself,
 * every constraint is counted twice, and a rule the export merely *reported*
 * becomes indistinguishable from one a human actually wrote.
 *
 * The markers are matched literally rather than by import, because
 * `conformance/` must not depend on `export/` — that would be a cycle between
 * two modules that have no business knowing about each other.
 *
 * Deliberately tolerant: an unmatched BEGIN truncates from there to the end,
 * because a half-written block from an interrupted run is still our output and
 * still must not be read back in.
 */
export function stripGeneratedBlocks(text: string): string {
  const begin = '<!-- BEGIN vibe-blueprint -->';
  const end = '<!-- END vibe-blueprint -->';

  let result = '';
  let cursor = 0;

  for (;;) {
    const start = text.indexOf(begin, cursor);
    if (start === -1) {
      result += text.slice(cursor);
      return result;
    }

    result += text.slice(cursor, start);
    const close = text.indexOf(end, start);
    if (close === -1) return result;
    cursor = close + end.length;
  }
}

async function readDocument(
  root: string,
  path: string,
  type: ConstraintSourceType,
): Promise<IntentDocument | null> {
  const absolute = join(root, ...path.split('/'));
  const onDisk = await readFile(absolute, 'utf8').catch(() => null);
  if (onDisk === null || onDisk.trim() === '') return null;

  const raw = stripGeneratedBlocks(onDisk);
  if (raw.trim() === '') return null;

  // TRUNCATION: a very long document is cut rather than skipped. Intent
  // statements cluster near the top of a README — the overview, not the API
  // reference — so the first 24k characters is where the yield is. Recorded on
  // the document so the report can say what was not read, rather than implying
  // full coverage.
  const truncated = raw.length > MAX_DOCUMENT_CHARS;
  return {
    type,
    location: relative(root, absolute).split(sep).join('/'),
    timestamp: null,
    text: truncated ? raw.slice(0, MAX_DOCUMENT_CHARS) : raw,
    truncated,
  };
}

/**
 * Splits a document into candidate statements, carrying line numbers.
 *
 * Line numbers are not decoration. Rule 3 says a constraint must point at its
 * origin, and "somewhere in README.md" is not pointing. A reader has to be able
 * to open the file and read the sentence for themselves, because the whole
 * claim this tool makes about STATED data is that it is quoted, not inferred.
 *
 * Sentence splitting is deliberately crude — markdown bullets, headings and
 * sentence-final punctuation. Prose in engineering documents is mostly short
 * declaratives and bullet lists, and an elaborate splitter would buy accuracy
 * on cases that do not carry constraints anyway.
 */
export function splitStatements(document: IntentDocument): Statement[] {
  const statements: Statement[] = [];
  const lines = document.text.split(/\r?\n/);

  let inFence = false;
  for (const [index, line] of lines.entries()) {
    // Fenced code is not prose. It is also where a hostile payload is most
    // likely to be parked, so skipping it removes a whole class of input.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const cleaned = line
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+\.\s+/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .trim();

    if (cleaned === '' || cleaned.length < 12) continue;
    // Table rows and horizontal rules carry no sentences worth extracting.
    if (/^\|/.test(cleaned) || /^[-=_*]{3,}$/.test(cleaned)) continue;

    for (const sentence of splitSentences(cleaned)) {
      statements.push({
        text: sentence,
        source: {
          type: document.type,
          location: document.location,
          line: index + 1,
          timestamp: document.timestamp,
        },
      });
    }
  }

  return statements;
}

function splitSentences(line: string): string[] {
  return line
    .split(/(?<=[.!?])\s+(?=[A-Z`"'*_[(])/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 12);
}
