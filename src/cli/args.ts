/**
 * Argument parsing. No business logic (CLAUDE.md rule 5) — this module turns
 * argv into a typed options object and nothing else.
 */
import { parseArgs } from 'node:util';
import { err, ok, type Result } from '../types/result.js';

export interface CliOptions {
  /** Path to analyse. Defaults to the current working directory. */
  readonly targetPath: string;
  /** Emit machine-readable JSON on stdout instead of a human summary. */
  readonly json: boolean;
  /** Print per-directory progress lines and the full file list. */
  readonly verbose: boolean;
  /** Open a browser once the server is up. `--no-open` clears it. */
  readonly open: boolean;
  /**
   * Start the local server and hold the process open. Cleared by `--no-serve`,
   * and by `--json`, which exists to be piped into something.
   */
  readonly serve: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

export interface ArgError {
  readonly kind: 'unknown-option' | 'too-many-arguments';
  readonly message: string;
}

export function parseArguments(argv: readonly string[]): Result<CliOptions, ArgError> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean', default: false },
        verbose: { type: 'boolean', short: 'v', default: false },
        'no-open': { type: 'boolean', default: false },
        'no-serve': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', default: false },
      },
    });
  } catch (cause: unknown) {
    return err({ kind: 'unknown-option', message: describeParseFailure(cause) });
  }

  if (parsed.positionals.length > 1) {
    return err({
      kind: 'too-many-arguments',
      message: `expected at most one target path, received ${parsed.positionals.length}`,
    });
  }

  const json = parsed.values.json === true;

  return ok({
    targetPath: parsed.positionals[0] ?? '.',
    json,
    verbose: parsed.values.verbose === true,
    open: parsed.values['no-open'] !== true && parsed.values['no-serve'] !== true && !json,
    // --json is for piping; holding the terminal open with a server would
    // defeat that, so it implies --no-serve.
    serve: parsed.values['no-serve'] !== true && !json,
    help: parsed.values.help === true,
    version: parsed.values.version === true,
  });
}

function describeParseFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'could not parse arguments';
}
