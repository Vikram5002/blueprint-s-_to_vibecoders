import { describe, expect, it } from 'vitest';
import { parseArguments } from './args.js';

function parse(argv: string[]) {
  const result = parseArguments(argv);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

describe('parseArguments', () => {
  it('defaults to the current directory with every flag off', () => {
    const options = parse([]);
    expect(options).toEqual({
      targetPath: '.',
      json: false,
      verbose: false,
      open: true,
      serve: true,
      // History is opt-in: it costs a worktree and a full re-analysis per
      // commit, so an ordinary run must never pay for it by accident.
      history: null,
      mcp: false,
      help: false,
      version: false,
    });
  });

  describe('--mcp', () => {
    it('never opens a port or a browser', () => {
      // stdout is a JSON-RPC transport in this mode. Starting the HTTP server
      // would also break the "no new network exposure" scope for the week.
      const options = parse(['--mcp']);
      expect(options.mcp).toBe(true);
      expect(options.serve).toBe(false);
      expect(options.open).toBe(false);
    });

    it('is off unless asked for', () => {
      expect(parse([]).mcp).toBe(false);
      expect(parse(['--json']).mcp).toBe(false);
    });
  });

  it('parses --history=N', () => {
    expect(parse(['--history=20']).history).toBe(20);
  });

  it('ignores a nonsensical history count rather than guessing', () => {
    // An expensive opt-in doing something unexpected on a typo is worse than
    // it doing nothing.
    expect(parse(['--history=abc']).history).toBeNull();
    expect(parse(['--history=0']).history).toBeNull();
    expect(parse(['--history=-5']).history).toBeNull();
  });

  it('caps the history walk, so a typo cannot start a thousand analyses', () => {
    expect(parse(['--history=99999']).history).toBe(200);
  });

  it('does not serve or open when emitting JSON', () => {
    // --json exists to be piped; holding the terminal open would defeat it.
    const options = parse(['--json']);
    expect(options.serve).toBe(false);
    expect(options.open).toBe(false);
  });

  it('serves without opening a browser for --no-open', () => {
    const options = parse(['--no-open']);
    expect(options.serve).toBe(true);
    expect(options.open).toBe(false);
  });

  it('neither serves nor opens for --no-serve', () => {
    const options = parse(['--no-serve']);
    expect(options.serve).toBe(false);
    expect(options.open).toBe(false);
  });

  it('takes the target path as a positional argument', () => {
    expect(parse(['../some-repo']).targetPath).toBe('../some-repo');
  });

  it('parses --json, --verbose and --no-open', () => {
    const options = parse(['.', '--json', '--verbose', '--no-open']);
    expect(options.json).toBe(true);
    expect(options.verbose).toBe(true);
    expect(options.open).toBe(false);
  });

  it('supports short flags', () => {
    expect(parse(['-v']).verbose).toBe(true);
    expect(parse(['-h']).help).toBe(true);
  });

  it('accepts flags before the path', () => {
    const options = parse(['--json', 'repo']);
    expect(options.targetPath).toBe('repo');
    expect(options.json).toBe(true);
  });

  it('rejects unknown options without throwing', () => {
    const result = parseArguments(['--nope']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unknown-option');
  });

  it('rejects more than one target path', () => {
    const result = parseArguments(['a', 'b']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('too-many-arguments');
  });
});
