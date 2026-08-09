#!/usr/bin/env node
/**
 * Binary entry point. The only place in the codebase that throws, exits, or
 * touches process streams directly.
 */
import { createRequire } from 'node:module';
import { EXIT_FAILURE, runCli } from './cli/run.js';
import { formatError } from './cli/output.js';
import { loadEnvFile } from './llm/env-file.js';

function readVersion(): string {
  // Both src/cli.ts and dist/cli.js sit one level below the package root.
  const require = createRequire(import.meta.url);
  const manifest: unknown = require('../package.json');
  if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
    const { version } = manifest as { version: unknown };
    if (typeof version === 'string') {
      return version;
    }
  }
  return '0.0.0';
}

async function main(): Promise<void> {
  /**
   * Load `.env` here, at the process boundary, rather than inside runCli.
   *
   * Two reasons, and the second was found the hard way. Mutating process.env is
   * a process-wide side effect and belongs where the process is set up. And
   * doing it inside runCli meant the CLI tests picked up a real GEMINI_API_KEY
   * from the developer's own repository root and started making live API calls
   * — they went from milliseconds to a 5-second timeout, and were quietly
   * spending quota to assert on a file count.
   *
   * Read from the working directory, never from the repository being analysed:
   * a key belongs to the person running the tool, and pointing this at an
   * untrusted checkout must not pick up a stranger's .env and spend against it.
   */
  loadEnvFile(process.cwd());

  const exitCode = await runCli(process.argv.slice(2), {
    writeOut: (line) => process.stdout.write(`${line}\n`),
    writeErr: (line) => process.stderr.write(`${line}\n`),
  }, readVersion());

  process.exitCode = exitCode;
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`${formatError(message)}\n`);
  process.exitCode = EXIT_FAILURE;
});
