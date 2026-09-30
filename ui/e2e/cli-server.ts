import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * Starts the real, built CLI as a subprocess and returns the URL it serves.
 *
 * Specs that need the real server spawn dist/cli.js rather than importing
 * anything from src/server/ - ui/ must not import src/ (CLAUDE.md rule 4),
 * and that applies to test code too - so the browser talks to it over real
 * HTTP, exactly as a real user's browser would.
 */
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const CLI_PATH = resolve(REPO_ROOT, 'dist/cli.js');
const FIXTURE_PATH = resolve(REPO_ROOT, 'src/graph/fixtures/ts-monorepo');

/** Generous: a cold start parses the fixture and opens the database before printing its URL. */
const STARTUP_TIMEOUT_MS = 45_000;

export interface RunningCli {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

export async function startCli(): Promise<RunningCli> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [CLI_PATH, FIXTURE_PATH, '--no-open'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });

  const baseUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      rejectUrl(new Error(`CLI did not print a server URL within ${STARTUP_TIMEOUT_MS / 1000}s.\nstdout: ${stdout}\nstderr: ${stderr}`));
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
      rejectUrl(new Error(`CLI exited early with code ${code} before printing a server URL.\nstderr: ${stderr}`));
    });
  });

  return {
    baseUrl,
    stop: () =>
      new Promise<void>((resolveStop) => {
        child.once('exit', () => resolveStop());
        child.kill();
      }),
  };
}
