/**
 * PHP symbol extraction.
 *
 * Pure: parsed tree in, records out. Specifiers stay raw and unresolved,
 * same discipline as extract-python.ts.
 *
 * Two independent dependency shapes exist in PHP, and they resolve
 * differently (Week: PHP resolver), so they get distinct ImportKinds:
 *
 * - `use` declarations (`use App\Models\User;`) name a fully-qualified class,
 *   function or const. PSR-4 autoloading maps the FQCN straight to a file path
 *   via composer.json — no directory scan needed, unlike Python.
 * - `require`/`require_once`/`include`/`include_once` take a filesystem path
 *   expression, most commonly `__DIR__ . '/relative.php'`. Only the literal
 *   string portion is extracted; a require whose target is entirely dynamic
 *   (a bare variable, a function call with no literal operand) has no
 *   evidence to build a DERIVED edge from and is skipped, same reasoning as
 *   Python's `from x import y` requiring a real dotted name.
 *
 * `namespace` declarations are not extracted as records: PSR-4 resolution is
 * computed purely from the FQCN plus composer.json's prefix map, so a file's
 * own declared namespace is never consulted to resolve someone else's import.
 */
import type { Node } from 'web-tree-sitter';
import type { Evidence } from '../types/graph.js';
import type { ImportRecord, ImportedName } from '../types/symbols.js';
import type { ExtractedSymbols } from './extract-ts.js';

const SNIPPET_MAX_LENGTH = 240;

const REQUIRE_INCLUDE_TYPES = [
  'require_expression',
  'require_once_expression',
  'include_expression',
  'include_once_expression',
] as const;

export function extractPhpSymbols(root: Node, filePath: string): ExtractedSymbols {
  const imports: ImportRecord[] = [];

  for (const node of root.descendantsOfType([...REQUIRE_INCLUDE_TYPES, 'namespace_use_declaration'])) {
    if (node === null) {
      continue;
    }
    if (node.type === 'namespace_use_declaration') {
      collectUse(node, filePath, imports);
    } else {
      collectRequireInclude(node, filePath, imports);
    }
  }

  return { imports, exports: [] };
}

/**
 * `require`/`include` (and their `_once` forms) take a single expression.
 * Only the literal string portion is usable as a specifier; `__DIR__` and
 * `dirname(__FILE__)` prefixes are dropped, leaving a path fragment the
 * resolver treats as relative to the file's own directory.
 */
function collectRequireInclude(node: Node, filePath: string, out: ImportRecord[]): void {
  const argument = node.namedChild(0);
  const specifier = argument === null ? null : stringLiteralIn(argument);
  if (specifier === null) {
    return;
  }

  out.push({
    specifier,
    kind: 'php-require',
    relativeLevel: 0,
    names: [],
    isNamespace: false,
    isDefault: false,
    isSideEffectOnly: true,
    evidence: evidenceFor(node, filePath),
  });
}

/** Recovers a literal string from a require/include argument expression. */
function stringLiteralIn(node: Node): string | null {
  if (node.type === 'parenthesized_expression') {
    const inner = node.namedChild(0);
    return inner === null ? null : stringLiteralIn(inner);
  }

  if (node.type === 'string') {
    return unwrapString(node);
  }

  if (node.type === 'encapsed_string') {
    return hasInterpolation(node) ? null : unwrapString(node);
  }

  if (node.type === 'binary_expression' && node.text.includes('.')) {
    const right = node.childForFieldName('right');
    const rightLiteral = right === null ? null : stringLiteralIn(right);
    if (rightLiteral !== null) {
      return rightLiteral;
    }
    const left = node.childForFieldName('left');
    return left === null ? null : stringLiteralIn(left);
  }

  return null;
}

function hasInterpolation(node: Node): boolean {
  return node.namedChildren.some((child) => child !== null && child.type !== 'string_content' && child.type !== 'escape_sequence');
}

function unwrapString(node: Node): string {
  const content = namedChildOfType(node, 'string_content');
  return content?.text ?? node.text.slice(1, -1);
}

/**
 * `use App\Models\User;`, `use App\Models\User as U;`,
 * `use function App\Helpers\format;`, `use const App\Constants\MAX;`, and the
 * grouped form `use App\Models\{User, Post as P};` all become one ImportRecord
 * per named target, sharing the statement's evidence — same convention as
 * Python's `collectImport`.
 */
function collectUse(node: Node, filePath: string, out: ImportRecord[]): void {
  const evidence = evidenceFor(node, filePath);
  const group = node.childForFieldName('body');

  if (group !== null && group.type === 'namespace_use_group') {
    const prefix = node.namedChild(0);
    if (prefix === null || prefix.type !== 'namespace_name') {
      return;
    }
    for (const clause of group.namedChildren) {
      if (clause === null || clause.type !== 'namespace_use_clause') {
        continue;
      }
      pushUseClause(clause, `${prefix.text}\\`, evidence, out);
    }
    return;
  }

  for (const clause of node.namedChildren) {
    if (clause === null || clause.type !== 'namespace_use_clause') {
      continue;
    }
    pushUseClause(clause, '', evidence, out);
  }
}

function pushUseClause(clause: Node, prefix: string, evidence: Evidence, out: ImportRecord[]): void {
  const nameNode = clause.namedChildren.find(
    (child): child is Node => child !== null && (child.type === 'qualified_name' || child.type === 'name'),
  );
  if (nameNode === undefined) {
    return;
  }

  const fqcn = `${prefix}${nameNode.text}`.replace(/^\\/, '');
  const alias = clause.childForFieldName('alias')?.text ?? null;
  const names: ImportedName[] = [{ name: fqcn, alias, isType: false }];

  out.push({
    specifier: fqcn,
    kind: 'php-use',
    relativeLevel: 0,
    names,
    isNamespace: false,
    isDefault: false,
    isSideEffectOnly: false,
    evidence,
  });
}

function evidenceFor(node: Node, filePath: string): Evidence {
  const single = node.text.replace(/\s+/g, ' ').trim();
  return {
    file: filePath,
    line: node.startPosition.row + 1,
    snippet: single.length > SNIPPET_MAX_LENGTH ? `${single.slice(0, SNIPPET_MAX_LENGTH)}…` : single,
  };
}

function namedChildOfType(node: Node, type: string): Node | null {
  return node.namedChildren.find((child): child is Node => child !== null && child.type === type) ?? null;
}
