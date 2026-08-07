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
      help: false,
      version: false,
    });
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
