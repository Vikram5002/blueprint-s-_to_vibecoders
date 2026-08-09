/**
 * A raw control byte in a source file has now been introduced four separate
 * times in this project — a NUL used as a hash separator, a NUL in an aggregate
 * key, a character class written out literally in a regex, and once inside a
 * comment explaining the previous fix.
 *
 * Every one of them behaved correctly at runtime, which is exactly why they
 * survived review: nothing failed. What breaks is the tooling around the code.
 * Git classifies the file as binary and stops producing diffs for it, grep
 * refuses to search it, and a reviewer sees "Bin 4021 -> 4380 bytes" where the
 * change should have been. The intent is always legitimate — a separator that
 * cannot occur in the input — and it is always better served by a unicode
 * escape, which compiles to the identical byte.
 *
 * So the rule is mechanical rather than a matter of care: source files contain
 * no control characters except tab, carriage return and newline. Write the
 * escape sequence, never the byte.
 */
import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, relative } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['src', join('ui', 'src'), 'scripts'];
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.css'];

/** Tab, newline, carriage return. Everything else below 0x20 is a mistake. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

/** Deliberately malformed by design: they are parser inputs, not source. */
const SKIP_DIRECTORIES = new Set(['fixtures', 'node_modules', 'dist']);

async function collect(directory: string, into: string[]): Promise<void> {
  const entries = await readdir(join(repoRoot, directory), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) await collect(child, into);
    } else if (EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      into.push(child);
    }
  }
}

describe('source hygiene', () => {
  it('contains no raw control characters', async () => {
    const files: string[] = [];
    for (const root of ROOTS) await collect(root, files);
    files.sort();

    // Guards the guard: a walk that silently found nothing would pass forever.
    expect(files.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const file of files) {
      const bytes = await readFile(join(repoRoot, file));
      for (const [index, byte] of bytes.entries()) {
        if (byte === 0x7f || (byte < 0x20 && !ALLOWED.has(byte))) {
          // Report the line, so the fix does not start with a byte hunt.
          const line = bytes.subarray(0, index).toString('utf8').split('\n').length;
          const code = `0x${byte.toString(16).padStart(2, '0')}`;
          offenders.push(`${relative('.', file).split('\\').join(posix.sep)}:${line} has ${code}`);
          break;
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
