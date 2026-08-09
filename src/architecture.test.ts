/**
 * The architectural rules from CLAUDE.md, enforced against the source rather
 * than trusted to discipline.
 *
 * Rules 1 and 4 are stated as non-negotiable, and until now both were held up
 * by nothing but care during review. That works right up until it doesn't: the
 * determinism boundary is one careless import away, and the import that breaks
 * it will look entirely reasonable in a diff — `graph/` wanting a label is a
 * perfectly natural thing to want.
 *
 * These are cheap to check statically, so they are checked statically.
 */
import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, relative } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function filesUnder(directory: string, extensions: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relativeDirectory: string): Promise<void> => {
    const entries = await readdir(join(repoRoot, relativeDirectory), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'fixtures'].includes(entry.name)) await walk(child);
      } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
        found.push(relative('.', child).split('\\').join(posix.sep));
      }
    }
  };
  await walk(directory);
  return found.sort();
}

/** Every module specifier this file imports or re-exports from. */
function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

describe('rule 1 — the determinism boundary', () => {
  /**
   * `pipeline/` is the composition root and is *supposed* to import from
   * `llm/`; that is the whole point of it existing. Everything else that
   * produces or shapes graph structure is on the deterministic side.
   *
   * `conformance/` is on this list although CLAUDE.md predates it. Subject
   * resolution decides which module a sentence is about, and that is structure
   * — exactly the case the rule covers.
   */
  const DETERMINISTIC = ['src/parser', 'src/graph', 'src/conformance', 'src/ingest', 'src/store'];

  it.each(DETERMINISTIC)('%s does not import from llm/', async (directory) => {
    const offenders: string[] = [];
    for (const file of await filesUnder(directory, ['.ts', '.tsx'])) {
      // Tests are exempt, and only tests. The rule is about what ships: a test
      // that verifies the boundary holds — injection.test.ts drives a stub
      // provider against the deterministic validators — has to be able to see
      // both sides of it. Every production file in these directories is still
      // checked, so a real violation cannot hide behind this.
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;

      const source = await readFile(join(repoRoot, file), 'utf8');
      for (const specifier of importedSpecifiers(source)) {
        if (/(^|\/)llm\//.test(specifier)) offenders.push(`${file} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('checks directories that actually contain code', async () => {
    for (const directory of DETERMINISTIC) {
      expect((await filesUnder(directory, ['.ts'])).length).toBeGreaterThan(0);
    }
  });
});

describe('rule 4 — the UI is a client, not a coupled module', () => {
  it('ui/ does not import from src/', async () => {
    const offenders: string[] = [];
    for (const file of await filesUnder(join('ui', 'src'), ['.ts', '.tsx'])) {
      const source = await readFile(join(repoRoot, file), 'utf8');
      for (const specifier of importedSpecifiers(source)) {
        // Relative escapes out of ui/, or anything naming the server's source.
        if (/(^|\/)\.\.\/\.\.\/src\//.test(specifier) || specifier.startsWith('src/')) {
          offenders.push(`${file} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('rule 2 — STATED and DERIVED never mix', () => {
  it('nothing outside the type definition can mint a DERIVED constraint', async () => {
    const offenders: string[] = [];
    for (const file of await filesUnder('src', ['.ts'])) {
      if (file.endsWith('constraints.ts')) continue;
      const source = await readFile(join(repoRoot, file), 'utf8');
      // A Constraint literal always carries `provenance: 'STATED'`. The failure
      // this guards is someone copying an edge builder and leaving DERIVED in.
      for (const match of source.matchAll(/provenance:\s*'DERIVED'/g)) {
        if (/constraint/i.test(source.slice(Math.max(0, match.index - 400), match.index))) {
          offenders.push(`${file} sets DERIVED provenance near constraint code`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
