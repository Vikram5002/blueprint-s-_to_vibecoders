/**
 * Fetching a repository to analyse from a Git URL.
 *
 * The one exception to CLAUDE.md rule 6 ("no network calls outside llm/"),
 * approved 2026-09-25 and named in the rule itself. It is deliberately narrow:
 *
 * - It only ever runs because a person pasted a URL and asked for it; nothing
 *   in the pipeline reaches this module on its own.
 * - It shells out to the system `git` with an argument array (never a shell
 *   string), `--` before the URL, and HTTPS URLs only, so a pasted value can
 *   neither run a command nor select a transport like `ext::` or `file://`.
 * - Credentials are never prompted for (GIT_TERMINAL_PROMPT=0 and
 *   GCM_INTERACTIVE=never), and a URL carrying `user:pass@` is refused, so a
 *   secret can never end up in a directory name, a log line or the database.
 *   Private repositories therefore fail with a clear message instead of a
 *   credential window appearing behind the browser.
 * - It clones shallow (`--depth 1`): the analysis reads the working tree, and
 *   history snapshots stay a CLI feature.
 *
 * Everything after the clone is the same local, deterministic pipeline a
 * local folder goes through - the clone is just a folder that happens to have
 * been fetched.
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { err, ok, type Result } from '../types/result.js';

export interface GitSource {
  /** Normalised HTTPS URL, always ending without `.git` and without a slash. */
  readonly url: string;
  readonly host: string;
  /** Path segments after the host - `owner/repo`, or `group/subgroup/repo` on GitLab. */
  readonly segments: readonly string[];
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;

/**
 * Accepts `https://host/owner/repo`, with or without `.git` or a trailing
 * slash, and the scheme-less `github.com/owner/repo` people copy from an
 * address bar. Anything else - another scheme, embedded credentials, a query,
 * a `..` segment - is refused with a reason a person can act on.
 */
export function parseGitUrl(input: string): Result<GitSource, string> {
  const trimmed = input.trim();
  if (trimmed === '') return err('Enter a repository URL, for example https://github.com/owner/repo');
  if (/^git@|^ssh:\/\//i.test(trimmed)) {
    return err('SSH URLs are not supported. Use the HTTPS URL, for example https://github.com/owner/repo');
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return err(`Not a valid URL: ${trimmed}`);
  }

  if (parsed.protocol !== 'https:') return err('Only https:// repository URLs are supported.');
  if (parsed.username !== '' || parsed.password !== '') {
    return err('Remove the username or token from the URL. Credentials are never stored or sent by this tool.');
  }
  if (parsed.search !== '' || parsed.hash !== '') return err('Remove the ?query or #fragment from the URL.');

  const segments = parsed.pathname
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter((segment) => segment !== '');
  if (segments.length < 2) return err('The URL must name a repository, for example https://github.com/owner/repo');
  if (!segments.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..')) {
    return err('The repository path contains characters that are not allowed.');
  }

  // `parsed.host` keeps a non-default port (https://host:8443/o/r); without
  // it the clone silently went to port 443. The folder name uses `_` for the
  // colon, which Windows does not allow in a path.
  const address = parsed.host.toLowerCase();
  const host = parsed.port === '' ? address : `${parsed.hostname.toLowerCase()}_${parsed.port}`;
  return ok({ url: `https://${address}/${segments.join('/')}`, host, segments });
}

/** Where a repository's clone lives: one stable folder per URL, so re-analysing the same URL replaces its clone instead of piling up copies. */
export function cloneDirectoryFor(baseDir: string, source: GitSource): string {
  return join(baseDir, source.host, ...source.segments);
}

export function validateBranch(branch: string): Result<string, string> {
  const trimmed = branch.trim();
  if (trimmed === '') return ok('');
  if (!BRANCH.test(trimmed) || trimmed.startsWith('-') || trimmed.includes('..')) {
    return err('The branch name contains characters that are not allowed.');
  }
  return ok(trimmed);
}

export interface CloneOptions {
  /** Branch or tag; empty means the repository's default branch. */
  readonly branch?: string;
  readonly timeoutMs?: number;
  /** Git's own progress, e.g. 45 for "Receiving objects:  45%". */
  readonly onProgress?: (percent: number, phase: string) => void;
}

export interface CloneResult {
  readonly directory: string;
  readonly commit: string;
}

const DEFAULT_CLONE_TIMEOUT_MS = 10 * 60_000;
const MAX_ERROR_OUTPUT_CHARS = 2_000;

/**
 * Clones `url` next to `directory`, into a fresh folder named after it, and
 * then removes the earlier clones of the same repository where it can.
 * `url` is passed to git as-is, so callers must validate it with
 * `parseGitUrl` first; tests pass a local repository path, which is why this
 * does not re-check.
 *
 * Never deletes before cloning: the clone being replaced may be the project
 * open right now, with its .vibe/blueprint.db held open inside it, and
 * Windows refuses to delete an open file (EBUSY). An earlier clone that is
 * still in use is left alone and removed by a later clone.
 */
export async function cloneRepository(url: string, directory: string, options: CloneOptions = {}): Promise<Result<CloneResult, string>> {
  const target = `${directory}@${Date.now().toString(36)}`;
  await mkdir(dirname(directory), { recursive: true });

  const args = ['clone', '--depth', '1', '--single-branch', '--progress'];
  if (options.branch !== undefined && options.branch !== '') args.push('--branch', options.branch);
  args.push('--', url, target);

  const cloned = await runGit(args, options.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS, options.onProgress);
  if (!cloned.ok) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    return err(explainCloneFailure(cloned.error));
  }

  await removeEarlierClones(directory, target);
  const head = await runGit(['-C', target, 'rev-parse', 'HEAD'], 30_000);
  return ok({ directory: target, commit: head.ok ? head.value.trim() : '' });
}

/** Best effort: a clone that is still open (see cloneRepository) stays until the next clone. */
async function removeEarlierClones(directory: string, keep: string): Promise<void> {
  const name = basename(directory);
  const entries = await readdir(dirname(directory)).catch(() => [] as string[]);
  for (const entry of entries) {
    if (entry !== name && !entry.startsWith(`${name}@`)) continue;
    const path = join(dirname(directory), entry);
    if (path === keep) continue;
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runGit(
  args: readonly string[],
  timeoutMs: number,
  onProgress?: (percent: number, phase: string) => void,
): Promise<Result<string, string>> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '' },
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(err(`timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-MAX_ERROR_OUTPUT_CHARS);
      if (onProgress !== undefined) {
        for (const match of text.matchAll(/([A-Za-z ]+):\s+(\d{1,3})%/g)) {
          onProgress(Number(match[2]), (match[1] ?? '').trim());
        }
      }
    });
    child.on('error', (cause) => {
      clearTimeout(timer);
      const missing = (cause as NodeJS.ErrnoException).code === 'ENOENT';
      resolve(err(missing ? 'git-not-installed' : String(cause)));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? ok(stdout) : err(stderr.trim() || `git exited with code ${String(code)}`));
    });
  });
}

function explainCloneFailure(output: string): string {
  if (output === 'git-not-installed') return 'Git is not installed on this machine (install it from https://git-scm.com and restart the tool).';
  if (/Remote branch .* not found|couldn't find remote ref/i.test(output)) return `That branch does not exist. Git said: ${lastLine(output)}`;
  if (/not found|could not read Username|Authentication failed|terminal prompts disabled|403/i.test(output)) {
    return 'Repository not found, or it is private. Only public repositories can be analysed from a URL; for a private one, clone it yourself and choose the folder instead.';
  }
  if (/Could not resolve host|unable to access/i.test(output)) return `Could not reach the server. Check the URL and your internet connection. Git said: ${lastLine(output)}`;
  return `git clone failed: ${lastLine(output)}`;
}

function lastLine(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  return lines.at(-1) ?? output;
}
