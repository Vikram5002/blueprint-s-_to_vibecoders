import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, join, resolve } from 'node:path';

/**
 * Starts the real, built CLI as a subprocess and returns the URL it serves.
 *
 * Specs that need the real server spawn dist/cli.js rather than importing
 * anything from src/server/ - ui/ must not import src/ (CLAUDE.md rule 4),
 * and that applies to test code too - so the browser talks to it over real
 * HTTP, exactly as a real user's browser would.
 *
 * Each call serves a fresh temporary copy of the fixture. The server keeps
 * its database (.vibe/) and generated projects (generated/) inside the folder
 * it serves, so pointing every spec at the checked-in fixture made them share
 * state: one run's saved sessions changed what the next run saw (a fixture
 * plan with a fixed session id showed "Generate again" instead of "Generate
 * Application", and a leftover session matched another spec's locator), and
 * generated projects piled up in the fixture folder. The copy is deleted when
 * the server stops.
 */
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const CLI_PATH = resolve(REPO_ROOT, 'dist/cli.js');
const FIXTURE_PATH = resolve(REPO_ROOT, 'src/graph/fixtures/ts-monorepo');

/** Never copied: server state and build output, not part of the fixture. */
const NOT_FIXTURE = new Set(['.vibe', 'generated', 'node_modules']);

/** Generous: a cold start parses the fixture and opens the database before printing its URL. */
const STARTUP_TIMEOUT_MS = 45_000;

export interface RunningCli {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

export interface StartCliOptions {
  /** Extra CLI arguments, e.g. ['--hosted']. */
  readonly args?: readonly string[];
  /** Extra environment variables for the server. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Run with no model keys at all: started from the temporary folder (so the
   * repository's .env is not read) and with every *_API_KEY / token variable
   * removed - the server then has no model of its own.
   */
  readonly withoutOwnKeys?: boolean;
}

export async function startCli(options: StartCliOptions = {}): Promise<RunningCli> {
  const root = mkdtempSync(join(tmpdir(), 'vibe-e2e-'));
  cpSync(FIXTURE_PATH, root, {
    recursive: true,
    filter: (source) => !NOT_FIXTURE.has(basename(source)),
  });
  const removeRoot = (): void =>
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  if (options.withoutOwnKeys === true) {
    for (const name of Object.keys(env)) {
      if (/(_API_KEY(_\d+)?|_TOKEN)$/.test(name) && options.env?.[name] === undefined)
        delete env[name];
    }
  }
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [CLI_PATH, root, '--no-open', ...(options.args ?? [])],
    { cwd: options.withoutOwnKeys === true ? root : REPO_ROOT, stdio: 'pipe', env },
  );

  const baseUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      rejectUrl(
        new Error(
          `CLI did not print a server URL within ${STARTUP_TIMEOUT_MS / 1000}s.\nstdout: ${stdout}\nstderr: ${stderr}`,
        ),
      );
    }, STARTUP_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout);
      if (match) {
        clearTimeout(timeout);
        resolveUrl(match[0]);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      removeRoot();
      rejectUrl(
        new Error(
          `CLI exited early with code ${code} before printing a server URL.\nstderr: ${stderr}`,
        ),
      );
    });
  });

  return {
    baseUrl,
    stop: () =>
      new Promise<void>((resolveStop) => {
        child.once('exit', () => {
          removeRoot();
          resolveStop();
        });
        child.kill();
      }),
  };
}
