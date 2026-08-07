#!/usr/bin/env node
/**
 * Binary entry point. The only place in the codebase that throws, exits, or
 * touches process streams directly.
 */
import { createRequire } from 'node:module';
import { EXIT_FAILURE, runCli } from './cli/run.js';
import { formatError } from './cli/output.js';

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
