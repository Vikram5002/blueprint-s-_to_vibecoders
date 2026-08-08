import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSourceParser, type SourceParser } from './parse.js';
import type { ImportRecord, ParsedFile } from '../types/symbols.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

let parser: SourceParser;

beforeAll(async () => {
  const created = await createSourceParser();
  if (!created.ok) {
    throw new Error(`could not create parser: ${created.error.message}`);
  }
  parser = created.value;
}, 30_000);

async function parseFixture(name: string): Promise<{ parsed: ParsedFile; source: string }> {
  const source = await readFile(`${FIXTURE_DIR}${name}`, 'utf8');
  const result = parser.parse({ path: `fixtures/${name}`, source });
  if (!result.ok) {
    throw new Error(`parse failed: ${result.error.message}`);
  }
  return { parsed: result.value, source };
}

function bySpecifier(imports: readonly ImportRecord[], specifier: string): ImportRecord {
  const found = imports.find((record) => record.specifier === specifier);
  if (found === undefined) {
    throw new Error(`no import for "${specifier}"; got: ${imports.map((i) => i.specifier).join(', ')}`);
  }
  return found;
}

/** Every record must point at a line that actually contains its specifier. */
function assertEvidenceIsReal(records: readonly ImportRecord[], source: string, path: string): void {
  const lines = source.split(/\r?\n/);
  for (const record of records) {
    expect(record.evidence.file, `file on ${record.specifier}`).toBe(path);
    expect(record.evidence.line, `line on ${record.specifier}`).toBeGreaterThan(0);
    expect(record.evidence.line).toBeLessThanOrEqual(lines.length);
    expect(record.evidence.snippet.length, `snippet on ${record.specifier}`).toBeGreaterThan(0);
    // The statement begins on `line`, so that line is part of the statement text.
    const startLine = lines[record.evidence.line - 1] ?? '';
    expect(record.evidence.snippet).toContain(startLine.trim().slice(0, 20));
  }
}

describe('ES import forms', () => {
  it('extracts every import form with its specifier', async () => {
    const { parsed } = await parseFixture('imports-basic.ts');

    expect(parsed.imports.map((i) => i.specifier).sort()).toEqual(
      [
        './side-effect-only',
        './default-only',
        './named',
        './aliased',
        './mixed',
        './namespace',
        './default-and-namespace',
        './multi-line',
      ].sort(),
    );
    expect(parsed.imports.every((i) => i.kind === 'import')).toBe(true);
  });

  it('records a side-effect import as binding nothing', async () => {
    const { parsed } = await parseFixture('imports-basic.ts');
    const record = bySpecifier(parsed.imports, './side-effect-only');

    expect(record.isSideEffectOnly).toBe(true);
    expect(record.names).toEqual([]);
    expect(record.isDefault).toBe(false);
    expect(record.isNamespace).toBe(false);
  });

  it('records default, named, aliased, mixed and namespace imports', async () => {
    const { parsed } = await parseFixture('imports-basic.ts');

    const defaultOnly = bySpecifier(parsed.imports, './default-only');
    expect(defaultOnly.isDefault).toBe(true);
    expect(defaultOnly.names).toEqual([{ name: 'default', alias: 'defaultOnly', isType: false }]);

    expect(bySpecifier(parsed.imports, './named').names).toEqual([
      { name: 'named', alias: null, isType: false },
      { name: 'other', alias: null, isType: false },
    ]);

    expect(bySpecifier(parsed.imports, './aliased').names).toEqual([
      { name: 'original', alias: 'renamed', isType: false },
    ]);

    const mixed = bySpecifier(parsed.imports, './mixed');
    expect(mixed.isDefault).toBe(true);
    expect(mixed.names).toEqual([
      { name: 'default', alias: 'defaultAndNamed', isType: false },
      { name: 'alsoNamed', alias: null, isType: false },
    ]);

    const namespace = bySpecifier(parsed.imports, './namespace');
    expect(namespace.isNamespace).toBe(true);
    expect(namespace.names).toEqual([{ name: '*', alias: 'namespace', isType: false }]);

    const both = bySpecifier(parsed.imports, './default-and-namespace');
    expect(both.isDefault).toBe(true);
    expect(both.isNamespace).toBe(true);
  });

  it('points a multi-line import at the line the statement starts on', async () => {
    const { parsed, source } = await parseFixture('imports-basic.ts');
    const record = bySpecifier(parsed.imports, './multi-line');
    const startLine = source.split(/\r?\n/)[record.evidence.line - 1] ?? '';

    expect(startLine.trim()).toBe('import {');
    // The snippet is the whole statement, newlines collapsed — so it holds the
    // specifier even though the specifier is on a later line.
    expect(record.evidence.snippet).toContain('./multi-line');
    expect(record.evidence.snippet).not.toContain('\n');
    expect(record.names.map((n) => n.name)).toEqual(['multiLineA', 'multiLineB']);
  });

  it('gives every import real evidence', async () => {
    const { parsed, source } = await parseFixture('imports-basic.ts');
    assertEvidenceIsReal(parsed.imports, source, 'fixtures/imports-basic.ts');
  });
});

describe('type-only import forms', () => {
  it('distinguishes `import type` from a value import', async () => {
    const { parsed } = await parseFixture('imports-type.ts');

    expect(bySpecifier(parsed.imports, './type-only').kind).toBe('import-type');
    expect(bySpecifier(parsed.imports, './default-type').kind).toBe('import-type');
    expect(bySpecifier(parsed.imports, './type-namespace').kind).toBe('import-type');
    expect(bySpecifier(parsed.imports, './mixed-inline').kind).toBe('import');
  });

  it('marks inline type specifiers inside a value import', async () => {
    const { parsed } = await parseFixture('imports-type.ts');

    expect(bySpecifier(parsed.imports, './mixed-inline').names).toEqual([
      { name: 'InlineType', alias: null, isType: true },
      { name: 'valueAlongside', alias: null, isType: false },
    ]);
  });

  it('handles `import x = require(...)`', async () => {
    const { parsed } = await parseFixture('imports-type.ts');
    const record = bySpecifier(parsed.imports, './legacy-require');

    expect(record.kind).toBe('import-require');
    expect(record.names).toEqual([{ name: '*', alias: 'legacyRequire', isType: false }]);
  });
});

describe('re-exports', () => {
  it('treats `export ... from` as both a dependency and an export', async () => {
    const { parsed, source } = await parseFixture('reexports.ts');

    expect(parsed.imports.map((i) => i.specifier).sort()).toEqual([
      './aliased-source',
      './named-source',
      './namespace-source',
      './star-source',
      './type-source',
    ]);
    expect(parsed.imports.every((i) => i.kind === 'export-from')).toBe(true);
    assertEvidenceIsReal(parsed.imports, source, 'fixtures/reexports.ts');
  });

  it('records the re-exported names', async () => {
    const { parsed } = await parseFixture('reexports.ts');
    const names = parsed.exports.map((e) => e.name);

    expect(names).toContain('reexported');
    expect(names).toContain('publicName');
    expect(names).toContain('aggregated');
    expect(names).toContain('ReexportedType');
    // `export * from` cannot name anything without resolving the target module.
    expect(parsed.exports.some((e) => e.kind === 'star-re-export' && e.name === '*')).toBe(true);
  });

  it('uses the alias as the public name', async () => {
    const { parsed } = await parseFixture('reexports.ts');

    expect(parsed.exports.map((e) => e.name)).not.toContain('original');
    expect(parsed.exports.map((e) => e.name)).toContain('publicName');
  });
});

describe('local exports', () => {
  it('extracts every exported symbol name', async () => {
    const { parsed } = await parseFixture('exports.ts');

    expect(parsed.exports.map((e) => e.name).sort()).toEqual(
      [
        'AbstractCls',
        'Cls',
        'Enum',
        'Iface',
        'TypeAlias',
        'ambient',
        'asyncFn',
        'constant',
        'default',
        'fn',
        'localA',
        'multipleA',
        'multipleB',
        'mutable',
        'renamedLocal',
      ].sort(),
    );
  });

  it('never invents an import for an export without a specifier', async () => {
    const { parsed } = await parseFixture('exports.ts');
    expect(parsed.imports).toEqual([]);
  });

  it('classifies type exports separately from value exports', async () => {
    const { parsed } = await parseFixture('exports.ts');
    const kindOf = (name: string) => parsed.exports.find((e) => e.name === name)?.kind;

    expect(kindOf('TypeAlias')).toBe('type');
    expect(kindOf('Iface')).toBe('type');
    expect(kindOf('constant')).toBe('value');
    expect(kindOf('Cls')).toBe('value');
    expect(kindOf('default')).toBe('default');
  });

  it('excludes symbols that are not exported', async () => {
    const { parsed } = await parseFixture('exports.ts');
    expect(parsed.exports.map((e) => e.name)).not.toContain('notExported');
    expect(parsed.exports.map((e) => e.name)).not.toContain('localB');
  });
});

describe('require()', () => {
  it('finds require calls including nested ones', async () => {
    const { parsed, source } = await parseFixture('requires.cjs');

    expect(parsed.imports.map((i) => i.specifier).sort()).toEqual([
      './destructured',
      './dev',
      './lazy-inside-function',
      './prod',
      './renamed-source',
      './simple',
    ]);
    expect(parsed.imports.every((i) => i.kind === 'require')).toBe(true);
    assertEvidenceIsReal(parsed.imports, source, 'fixtures/requires.cjs');
  });

  it('skips a require with a non-literal specifier rather than guessing', async () => {
    const { parsed } = await parseFixture('requires.cjs');
    expect(parsed.imports.map((i) => i.specifier)).not.toContain('dynamicName');
  });

  it('ignores a `require` method on another object', async () => {
    const { parsed } = await parseFixture('requires.cjs');
    expect(parsed.imports.map((i) => i.specifier)).not.toContain('./not-a-real-import');
  });

  it('points require evidence at the call, not the file start', async () => {
    const { parsed, source } = await parseFixture('requires.cjs');
    const lazy = bySpecifier(parsed.imports, './lazy-inside-function');
    const line = source.split(/\r?\n/)[lazy.evidence.line - 1] ?? '';

    expect(line).toContain('./lazy-inside-function');
    expect(lazy.evidence.snippet).toContain('require');
  });
});

describe('dynamic import()', () => {
  it('finds dynamic imports including nested and template-literal forms', async () => {
    const { parsed, source } = await parseFixture('dynamic-imports.js');

    expect(parsed.imports.map((i) => i.specifier).sort()).toEqual([
      './awaited',
      './bare-statement',
      './nested-inside-function',
      './templated',
      './thenned',
    ]);
    expect(parsed.imports.every((i) => i.kind === 'dynamic-import')).toBe(true);
    assertEvidenceIsReal(parsed.imports, source, 'fixtures/dynamic-imports.js');
  });

  it('skips a dynamic import with a computed specifier', async () => {
    const { parsed } = await parseFixture('dynamic-imports.js');
    expect(parsed.imports.map((i) => i.specifier)).not.toContain('name');
  });
});

describe('TSX', () => {
  it('parses JSX and extracts its imports', async () => {
    const { parsed } = await parseFixture('component.tsx');

    expect(parsed.hadSyntaxErrors).toBe(false);
    expect(parsed.imports.map((i) => i.specifier).sort()).toEqual(['./button', 'react', 'react']);
    expect(parsed.exports.map((e) => e.name).sort()).toEqual(['Panel', 'Props', 'default']);
  });
});

describe('malformed input', () => {
  it('does not throw, flags the file, and keeps what it recovered', async () => {
    const { parsed } = await parseFixture('broken.ts');

    expect(parsed.hadSyntaxErrors).toBe(true);
    expect(parsed.imports.map((i) => i.specifier)).toContain('./recoverable-before-the-damage');
  });

  it('reports clean files as free of syntax errors', async () => {
    const { parsed } = await parseFixture('imports-basic.ts');
    expect(parsed.hadSyntaxErrors).toBe(false);
  });

  it('keeps every import when a later declaration fails to parse', async () => {
    // Variance annotations (`in`/`out`, TS 4.7) are not in the vendored grammar,
    // so this declaration produces an ERROR node. Recovery must stay local: the
    // dependency edges Week 3 builds come from imports, and losing one silently
    // would corrupt the graph. Exports inside the damaged region are forfeit.
    const result = parser.parse({
      path: 'variance.ts',
      source: [
        `import { A } from './a';`,
        `import { B } from './b';`,
        `export interface Broken<in T = never> { value: T }`,
        `export const after = 1;`,
      ].join('\n'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hadSyntaxErrors).toBe(true);
    expect(result.value.imports.map((i) => i.specifier)).toEqual(['./a', './b']);
    expect(result.value.exports.map((e) => e.name)).toContain('after');
  });

  it('handles an empty file', async () => {
    const result = parser.parse({ path: 'empty.ts', source: '' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.imports).toEqual([]);
    expect(result.value.exports).toEqual([]);
    expect(result.value.hadSyntaxErrors).toBe(false);
  });

  it('survives content that is not source code at all', async () => {
    // Built from code points rather than pasted literally: raw control bytes in
    // a source file make the file itself unparseable, which the tool then
    // reports when it scans its own repository.
    const binaryLooking = `${String.fromCharCode(0, 1, 2, 0xfffd)} not code`;

    const result = parser.parse({ path: 'binary.js', source: binaryLooking });
    expect(result.ok).toBe(true);
  });
});
