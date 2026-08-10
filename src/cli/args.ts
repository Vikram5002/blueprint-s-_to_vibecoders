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
  /**
   * Build one snapshot per commit for the last N commits and chart drift.
   *
   * Off by default and opt-in with a count, because it materialises a git
   * worktree per commit and re-analyses each one — seconds per commit, not
   * milliseconds. Nobody should pay that on an ordinary run.
   */
  readonly history: number | null;
  /**
   * Speak MCP on stdin/stdout instead of printing a summary.
   *
   * Implies `--no-serve` and `--no-open`, and silences every human-facing line
   * on stdout: in this mode stdout is a JSON-RPC transport, and a single stray
   * summary line corrupts the stream for the client. Diagnostics still go to
   * stderr, which MCP clients ignore.
   */
  readonly mcp: boolean;
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
        history: { type: 'string' },
        mcp: { type: 'boolean', default: false },
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
  const mcp = parsed.values.mcp === true;

  return ok({
    targetPath: parsed.positionals[0] ?? '.',
    json,
    verbose: parsed.values.verbose === true,
    open: parsed.values['no-open'] !== true && parsed.values['no-serve'] !== true && !json && !mcp,
    // --json is for piping; holding the terminal open with a server would
    // defeat that, so it implies --no-serve. --mcp owns stdout for the same
    // reason and additionally must not open a port.
    serve: parsed.values['no-serve'] !== true && !json && !mcp,
    history: parseHistory(parsed.values['history']),
    mcp,
    help: parsed.values.help === true,
    version: parsed.values.version === true,
  });
}

function describeParseFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'could not parse arguments';
}

/**
 * `--history=N`. Absent means no history walk; a bad value means none either,
 * rather than a crash or a silent 0 — this is an expensive opt-in and doing
 * something unexpected with a typo would be worse than doing nothing.
 */
function parseHistory(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 1 ? Math.min(parsed, 200) : null;
}
