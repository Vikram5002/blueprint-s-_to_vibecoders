/** Pure helpers - no VS Code API - so they can be tested on their own. */
import type { ReworkCheck } from './api';

/** The address the CLI prints once it is serving: "  Blueprint ready at  http://127.0.0.1:51234". */
export function parseServerUrl(output: string): string | null {
  const match = /ready at\s+(https?:\/\/[^\s]+)/.exec(output);
  return match?.[1] ?? null;
}

/** A `text/uri-list` drop: one URI per line, `#` lines are comments. */
export function parseUriList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** Path of `file` relative to `root`, with forward slashes; null when outside it. */
export function relativeTo(root: string, file: string): string | null {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root);
  const f = norm(file);
  const caseless = /^[a-zA-Z]:\//.test(r);
  const rootCmp = caseless ? r.toLowerCase() : r;
  const fileCmp = caseless ? f.toLowerCase() : f;
  if (!fileCmp.startsWith(`${rootCmp}/`)) return null;
  return f.slice(r.length + 1);
}

/** One line for the Keep/Discard question, from the server's own checks. */
export function summariseChecks(checks: readonly ReworkCheck[]): string {
  if (checks.length === 0) return 'No rule was broken before; this change is the one you asked for.';
  const fixed = checks.filter((check) => !check.stillPresent).length;
  if (fixed === checks.length) return `All ${checks.length} violating import(s) are gone (quick check).`;
  return `${fixed} of ${checks.length} violating import(s) are gone; ${checks.length - fixed} still there (quick check).`;
}

/** The detail lines under the question: one per checked violation. */
export function checkDetails(checks: readonly ReworkCheck[]): string {
  return checks
    .map((check) => `${check.stillPresent ? 'STILL THERE' : 'fixed'} - line ${check.line}: ${check.snippet.trim()}  (${check.ruleText})`)
    .join('\n');
}
