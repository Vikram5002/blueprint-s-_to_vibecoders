import { beforeAll, describe, expect, it } from 'vitest';
import { createSourceParser, type SourceParser } from './parse.js';
import type { ImportRecord } from '../types/symbols.js';

let parser: SourceParser;

beforeAll(async () => {
  const created = await createSourceParser();
  if (!created.ok) throw new Error(created.error.message);
  parser = created.value;
}, 30_000);

function parseSource(source: string, path = 'mod.php'): readonly ImportRecord[] {
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

describe('php: use declarations', () => {
  it('extracts a plain `use`', () => {
    const record = only('<?php use App\\Models\\User;');
    expect(record.specifier).toBe('App\\Models\\User');
    expect(record.kind).toBe('php-use');
    expect(record.names).toEqual([{ name: 'App\\Models\\User', alias: null, isType: false }]);
  });

  it('extracts an aliased `use`', () => {
    const record = only('<?php use App\\Models\\User as U;');
    expect(record.specifier).toBe('App\\Models\\User');
    expect(record.names[0]?.alias).toBe('U');
  });

  it('extracts `use function`', () => {
    const record = only('<?php use function App\\Helpers\\format;');
    expect(record.specifier).toBe('App\\Helpers\\format');
    expect(record.kind).toBe('php-use');
  });

  it('extracts `use const`', () => {
    const record = only('<?php use const App\\Constants\\MAX;');
    expect(record.specifier).toBe('App\\Constants\\MAX');
  });

  it('extracts a leading-backslash absolute use', () => {
    const record = only('<?php use \\App\\Foo;');
    expect(record.specifier).toBe('App\\Foo');
  });

  it('extracts a single-segment use', () => {
    const record = only('<?php use Something;');
    expect(record.specifier).toBe('Something');
  });

  it('expands a grouped use into one record per member', () => {
    const records = parseSource('<?php use App\\Models\\{User, Post as P};');
    expect(records).toHaveLength(2);
    expect(records[0]?.specifier).toBe('App\\Models\\User');
    expect(records[0]?.names[0]?.alias).toBeNull();
    expect(records[1]?.specifier).toBe('App\\Models\\Post');
    expect(records[1]?.names[0]?.alias).toBe('P');
  });

  it('shares one evidence line across a grouped use', () => {
    const records = parseSource('<?php use App\\Models\\{User, Post};');
    expect(records[0]?.evidence.line).toBe(records[1]?.evidence.line);
  });

  it('reports the correct line number', () => {
    const record = only('<?php\n\nuse App\\Models\\User;');
    expect(record.evidence.line).toBe(3);
  });
});

describe('php: require/include', () => {
  it('extracts a plain string require', () => {
    const record = only("<?php require 'bootstrap.php';");
    expect(record.specifier).toBe('bootstrap.php');
    expect(record.kind).toBe('php-require');
    expect(record.isSideEffectOnly).toBe(true);
  });

  it('extracts require_once', () => {
    expect(only("<?php require_once 'a.php';").kind).toBe('php-require');
  });

  it('extracts include and include_once', () => {
    expect(only("<?php include 'a.php';").specifier).toBe('a.php');
    expect(only("<?php include_once('a.php');").specifier).toBe('a.php');
  });

  it('strips a leading __DIR__ concatenation, keeping the literal remainder', () => {
    const record = only("<?php require __DIR__ . '/../bootstrap.php';");
    expect(record.specifier).toBe('/../bootstrap.php');
  });

  it('strips a leading dirname(__FILE__) concatenation', () => {
    const record = only('<?php require dirname(__FILE__) . "/config.php";');
    expect(record.specifier).toBe('/config.php');
  });

  it('skips a require with no literal component', () => {
    expect(parseSource('<?php require $path;')).toHaveLength(0);
  });

  it('skips a require with string interpolation', () => {
    expect(parseSource('<?php $x = "y"; require "{$dir}/a.php";')).toHaveLength(0);
  });

  it('reports the correct line number', () => {
    const record = only("<?php\n\nrequire 'a.php';");
    expect(record.evidence.line).toBe(3);
  });
});

describe('php: namespace declarations do not produce import records', () => {
  it('ignores a namespace declaration on its own', () => {
    expect(parseSource('<?php namespace App\\Models;')).toHaveLength(0);
  });

  it('still extracts use/require alongside a namespace declaration', () => {
    const records = parseSource("<?php namespace App\\Models;\nuse App\\Contracts\\HasName;\nrequire 'x.php';");
    expect(records).toHaveLength(2);
  });
});
