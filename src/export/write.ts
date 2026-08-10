/**
 * Writing the two export formats to disk.
 *
 * Kept out of `cli/` (rule 5) and out of the renderers, so both of those stay
 * pure functions that a test can call without touching a filesystem.
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { renderAgentsMarkdown, spliceIntoDocument, type ExportMeta } from './agents-md.js';
import { renderStaticHtml } from './static-html.js';
import type { AnalysisContext } from '../server/context.js';

const run = promisify(execFile);

export const AGENTS_FILE = 'AGENTS.md';
export const HTML_FILE = 'blueprint.html';

export interface WrittenExport {
  readonly path: string;
  readonly bytes: number;
}

/**
 * The commit the measurement describes, or null outside a git repository.
 *
 * Null rather than a throw or a placeholder: analysing a plain directory is a
 * perfectly ordinary thing to do, and an export that refused to write because
 * there was no git history would be useless in exactly the vibe-coded folders
 * this tool is aimed at. The report says "not a git repository" instead.
 */
export async function currentCommit(root: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: root });
    const sha = stdout.trim();
    return sha === '' ? null : sha;
  } catch {
    return null;
  }
}

export async function writeExports(
  context: AnalysisContext,
  meta: ExportMeta,
): Promise<readonly WrittenExport[]> {
  const written: WrittenExport[] = [];

  /**
   * AGENTS.md is spliced, not overwritten. A developer's own notes in that
   * file are theirs; only the block between the markers is ours to regenerate.
   */
  const agentsPath = join(context.root, AGENTS_FILE);
  const existing = await readFile(agentsPath, 'utf8').catch(() => '');
  const spliced = spliceIntoDocument(existing, renderAgentsMarkdown(context, meta));
  await writeFile(agentsPath, spliced, 'utf8');
  written.push({ path: agentsPath, bytes: Buffer.byteLength(spliced) });

  const htmlPath = join(context.root, HTML_FILE);
  const html = renderStaticHtml(context, meta);
  await writeFile(htmlPath, html, 'utf8');
  written.push({ path: htmlPath, bytes: Buffer.byteLength(html) });

  return written;
}
