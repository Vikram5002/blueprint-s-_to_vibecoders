import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSourceParser, type SourceParser } from './parse.js';
import type { ImportRecord } from '../types/symbols.js';

const PY_PACKAGE = fileURLToPath(new URL('../graph/fixtures/py-package/', import.meta.url));

let parser: SourceParser;

beforeAll(async () => {
  const created = await createSourceParser();
  if (!created.ok) throw new Error(created.error.message);
  parser = created.value;
}, 30_000);

function parseSource(source: string, path = 'mod.py'): readonly ImportRecord[] {
  const result = parser.parse({ path, source });
  if (!result.ok) throw new Error(`parse failed: ${result.error.message}`);
  return result.value.imports;
}

function only(source: string): ImportRecord {
  const records = parseSource(source);
  expect(records).toHaveLength(1);
  const first = records[0];
  if (first === undefined) throw new Error('no record');
  return first;
}

describe('python: plain imports', () => {
  it('extracts `import x`', () => {
    const record = only('import os');
    expect(record.specifier).toBe('os');
    expect(record.kind).toBe('python-import');
    expect(record.relativeLevel).toBe(0);
  });

  it('keeps the full dotted path of `import x.y`', () => {
    expect(only('import os.path').specifier).toBe('os.path');
  });

  it('records the alias of `import x.y as z`', () => {
    const record = only('import os.path as osp');
    expect(record.specifier).toBe('os.path');
    expect(record.names).toEqual([{ name: 'os.path', alias: 'osp', isType: false }]);
  });

  it('splits `import a, b.c, d as e` into one record per module', () => {
    const records = parseSource('import a, b.c, d as e');

    expect(records.map((r) => r.specifier)).toEqual(['a', 'b.c', 'd']);
    expect(records[2]?.names).toEqual([{ name: 'd', alias: 'e', isType: false }]);
    // One statement, so all three share a line and a snippet.
    expect(new Set(records.map((r) => r.evidence.line))).toEqual(new Set([1]));
  });
});

describe('python: from-imports', () => {
  it('extracts `from x import y`', () => {
    const record = only('from x import y');
    expect(record.specifier).toBe('x');
    expect(record.kind).toBe('python-from');
    expect(record.names).toEqual([{ name: 'y', alias: null, isType: false }]);
  });

  it('extracts a dotted module with an aliased name', () => {
    const record = only('from x.y import z as w');
    expect(record.specifier).toBe('x.y');
    expect(record.names).toEqual([{ name: 'z', alias: 'w', isType: false }]);
  });

  it('handles a parenthesised multi-line import', () => {
    const record = only('from x import (\n    one,\n    two as three,\n)');

    expect(record.specifier).toBe('x');
    expect(record.names).toEqual([
      { name: 'one', alias: null, isType: false },
      { name: 'two', alias: 'three', isType: false },
    ]);
    expect(record.evidence.line).toBe(1);
    expect(record.evidence.snippet).not.toContain('\n');
    expect(record.evidence.snippet).toContain('two as three');
  });

  it('marks a wildcard import', () => {
    const record = only('from x import *');
    expect(record.specifier).toBe('x');
    expect(record.names).toEqual([{ name: '*', alias: null, isType: false }]);
    expect(record.isNamespace).toBe(true);
  });
});

describe('python: relative imports', () => {
  it('counts one dot and leaves the specifier empty for `from . import y`', () => {
    const record = only('from . import sibling');

    expect(record.relativeLevel).toBe(1);
    expect(record.specifier).toBe('');
    expect(record.names).toEqual([{ name: 'sibling', alias: null, isType: false }]);
  });

  it('strips the dot from `from .mod import thing`', () => {
    const record = only('from .mod import thing');
    expect(record.relativeLevel).toBe(1);
    expect(record.specifier).toBe('mod');
  });

  it('counts two dots for `from ..pkg import thing`', () => {
    const record = only('from ..pkg import thing');
    expect(record.relativeLevel).toBe(2);
    expect(record.specifier).toBe('pkg');
  });

  it('counts three dots and keeps the dotted remainder', () => {
    const record = only('from ...deep.pkg import a, b');

    expect(record.relativeLevel).toBe(3);
    expect(record.specifier).toBe('deep.pkg');
    expect(record.names.map((n) => n.name)).toEqual(['a', 'b']);
  });
});

describe('python: conditional and nested imports', () => {
  it('finds imports inside try/except', () => {
    const records = parseSource('try:\n    import ujson as impl\nexcept ImportError:\n    import json as impl');

    expect(records.map((r) => r.specifier)).toEqual(['ujson', 'json']);
    expect(records.map((r) => r.evidence.line)).toEqual([2, 4]);
  });

  it('finds imports inside `if TYPE_CHECKING`', () => {
    const records = parseSource('if TYPE_CHECKING:\n    from .types import T');

    expect(records).toHaveLength(1);
    expect(records[0]?.relativeLevel).toBe(1);
    expect(records[0]?.specifier).toBe('types');
  });

  it('finds an import nested in a function body', () => {
    const records = parseSource('def load():\n    import heavy\n    return heavy');
    expect(records.map((r) => r.specifier)).toEqual(['heavy']);
    expect(records[0]?.evidence.line).toBe(2);
  });
});

describe('python: evidence', () => {
  it('gives every record a real file, line and snippet', async () => {
    const source = await readFile(`${PY_PACKAGE}myapp/main.py`, 'utf8');
    const records = parseSource(source, 'myapp/main.py');
    const lines = source.split(/\r?\n/);

    expect(records.length).toBeGreaterThan(10);
    for (const record of records) {
      expect(record.evidence.file).toBe('myapp/main.py');
      expect(record.evidence.line).toBeGreaterThan(0);
      expect(record.evidence.line).toBeLessThanOrEqual(lines.length);
      const startLine = (lines[record.evidence.line - 1] ?? '').trim();
      expect(startLine.startsWith('import') || startLine.startsWith('from')).toBe(true);
    }
  });

  it('produces no import records for a file with none', () => {
    expect(parseSource('x = 1\ndef f():\n    return x\n')).toEqual([]);
  });

  it('does not treat __import__ as a static import', () => {
    expect(parseSource("__import__('dynamic')")).toEqual([]);
  });
});

describe('python: error tolerance', () => {
  it('recovers from a malformed file and keeps earlier imports', () => {
    const result = parser.parse({
      path: 'bad.py',
      source: 'import os\nfrom . import good\ndef broken(:\n    ][\n',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hadSyntaxErrors).toBe(true);
    expect(result.value.imports.map((i) => i.specifier)).toContain('os');
  });

  it('reports python as the language', () => {
    const result = parser.parse({ path: 'x.py', source: 'import os' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.language).toBe('python');
  });
});
