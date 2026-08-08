/**
 * TypeScript / JavaScript symbol extraction.
 *
 * Pure: takes a parsed tree, returns records. No I/O, no mutation of inputs.
 * Specifiers stay raw — resolving them to files is Week 3.
 *
 * Architectural rule 3 in practice: every record produced here carries the file,
 * the 1-based line and the source text that produced it. If a construct cannot
 * be tied to a real string literal in the source, it is skipped rather than
 * recorded with a guessed specifier.
 */
import type { Node } from 'web-tree-sitter';
import type { Evidence } from '../types/graph.js';
import type { ExportRecord, ImportRecord, ImportedName } from '../types/symbols.js';

export interface ExtractedSymbols {
  readonly imports: readonly ImportRecord[];
  readonly exports: readonly ExportRecord[];
}

const SNIPPET_MAX_LENGTH = 240;

/** Nodes that count as "the statement" when attributing a nested call. */
const STATEMENT_TYPES: ReadonlySet<string> = new Set([
  'expression_statement',
  'lexical_declaration',
  'variable_declaration',
  'return_statement',
  'import_statement',
  'export_statement',
  'if_statement',
  'for_statement',
  'while_statement',
  'throw_statement',
  'public_field_definition',
]);

export function extractTypeScriptSymbols(root: Node, filePath: string): ExtractedSymbols {
  const imports: ImportRecord[] = [];
  const exports: ExportRecord[] = [];

  for (const node of root.descendantsOfType(['import_statement', 'export_statement', 'call_expression'])) {
    if (node === null) {
      continue;
    }
    if (node.type === 'import_statement') {
      collectImportStatement(node, filePath, imports);
    } else if (node.type === 'export_statement') {
      collectExportStatement(node, filePath, imports, exports);
    } else {
      collectCallExpression(node, filePath, imports);
    }
  }

  return { imports, exports };
}

// --- imports ---------------------------------------------------------------

function collectImportStatement(node: Node, filePath: string, out: ImportRecord[]): void {
  const requireClause = namedChildOfType(node, 'import_require_clause');
  const source = requireClause !== null
    ? requireClause.childForFieldName('source')
    : node.childForFieldName('source');

  const specifier = source === null ? null : staticStringValue(source);
  if (specifier === null) {
    return;
  }

  if (requireClause !== null) {
    const binding = namedChildOfType(requireClause, 'identifier');
    out.push({
      specifier,
      kind: 'import-require',
      names: [{ name: '*', alias: binding?.text ?? null, isType: false }],
      isNamespace: false,
      isDefault: false,
      isSideEffectOnly: false,
      evidence: evidenceFor(node, filePath),
    });
    return;
  }

  const clause = namedChildOfType(node, 'import_clause');
  const names = clause === null ? [] : importClauseNames(clause);

  out.push({
    specifier,
    kind: hasUnnamedChild(node, 'type') ? 'import-type' : 'import',
    names,
    isNamespace: clause !== null && namedChildOfType(clause, 'namespace_import') !== null,
    isDefault: clause !== null && namedChildOfType(clause, 'identifier') !== null,
    isSideEffectOnly: clause === null,
    evidence: evidenceFor(node, filePath),
  });
}

function importClauseNames(clause: Node): ImportedName[] {
  const names: ImportedName[] = [];

  for (const child of namedChildren(clause)) {
    if (child.type === 'identifier') {
      names.push({ name: 'default', alias: child.text, isType: false });
    } else if (child.type === 'namespace_import') {
      const binding = namedChildOfType(child, 'identifier');
      names.push({ name: '*', alias: binding?.text ?? null, isType: false });
    } else if (child.type === 'named_imports') {
      names.push(...specifierNames(child, 'import_specifier'));
    }
  }

  return names;
}

/** Shared shape: `import_specifier` and `export_specifier` both use name/alias. */
function specifierNames(container: Node, specifierType: string): ImportedName[] {
  const names: ImportedName[] = [];

  for (const specifier of namedChildren(container)) {
    if (specifier.type !== specifierType) {
      continue;
    }
    const name = specifier.childForFieldName('name');
    if (name === null) {
      continue;
    }
    names.push({
      name: name.text,
      alias: specifier.childForFieldName('alias')?.text ?? null,
      isType: hasUnnamedChild(specifier, 'type'),
    });
  }

  return names;
}

function collectCallExpression(node: Node, filePath: string, out: ImportRecord[]): void {
  const callee = node.childForFieldName('function');
  if (callee === null) {
    return;
  }

  // `require(...)` only when the callee is the bare identifier. `obj.require(...)`
  // parses as a member_expression and is not a module import.
  const isRequire = callee.type === 'identifier' && callee.text === 'require';
  const isDynamicImport = callee.type === 'import';
  if (!isRequire && !isDynamicImport) {
    return;
  }

  const args = node.childForFieldName('arguments');
  const first = args === null ? null : namedChildren(args)[0] ?? null;
  const specifier = first === null ? null : staticStringValue(first);
  if (specifier === null) {
    // Computed specifier — nothing static to point at, so record nothing.
    return;
  }

  out.push({
    specifier,
    kind: isRequire ? 'require' : 'dynamic-import',
    names: [],
    isNamespace: false,
    isDefault: false,
    isSideEffectOnly: false,
    evidence: evidenceFor(enclosingStatement(node), filePath),
  });
}

// --- exports ---------------------------------------------------------------

function collectExportStatement(
  node: Node,
  filePath: string,
  imports: ImportRecord[],
  exports: ExportRecord[],
): void {
  const source = node.childForFieldName('source');
  if (source !== null) {
    collectReExport(node, source, filePath, imports, exports);
    return;
  }

  const evidence = evidenceFor(node, filePath);

  if (hasUnnamedChild(node, 'default')) {
    exports.push({ name: 'default', kind: 'default', evidence });
    return;
  }

  const clause = namedChildOfType(node, 'export_clause');
  if (clause !== null) {
    for (const name of specifierNames(clause, 'export_specifier')) {
      exports.push({
        name: name.alias ?? name.name,
        kind: name.isType ? 'type' : 'value',
        evidence,
      });
    }
    return;
  }

  const declaration = node.childForFieldName('declaration');
  if (declaration !== null) {
    exports.push(...declarationExports(declaration, evidence));
  }
}

function collectReExport(
  node: Node,
  source: Node,
  filePath: string,
  imports: ImportRecord[],
  exports: ExportRecord[],
): void {
  const specifier = staticStringValue(source);
  if (specifier === null) {
    return;
  }

  const evidence = evidenceFor(node, filePath);
  const clause = namedChildOfType(node, 'export_clause');
  const namespaceExport = namedChildOfType(node, 'namespace_export');
  const names = clause === null ? [] : specifierNames(clause, 'export_specifier');

  imports.push({
    specifier,
    kind: 'export-from',
    names,
    isNamespace: namespaceExport !== null,
    isDefault: false,
    isSideEffectOnly: false,
    evidence,
  });

  if (namespaceExport !== null) {
    const binding = namedChildOfType(namespaceExport, 'identifier');
    exports.push({ name: binding?.text ?? '*', kind: 're-export', evidence });
    return;
  }

  if (clause === null) {
    // `export * from './m'` — the names live in the target module.
    exports.push({ name: '*', kind: 'star-re-export', evidence });
    return;
  }

  for (const name of names) {
    exports.push({ name: name.alias ?? name.name, kind: 're-export', evidence });
  }
}

const TYPE_DECLARATIONS: ReadonlySet<string> = new Set(['interface_declaration', 'type_alias_declaration']);

function declarationExports(declaration: Node, evidence: Evidence): ExportRecord[] {
  // `export declare const x` wraps the real declaration in an ambient_declaration.
  if (declaration.type === 'ambient_declaration') {
    return namedChildren(declaration).flatMap((child) => declarationExports(child, evidence));
  }

  if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
    return namedChildren(declaration)
      .filter((child) => child.type === 'variable_declarator')
      .map((child) => child.childForFieldName('name'))
      .filter((name): name is Node => name !== null && name.type === 'identifier')
      .map((name) => ({ name: name.text, kind: 'value' as const, evidence }));
  }

  const name = declaration.childForFieldName('name');
  if (name === null) {
    return [];
  }
  return [{ name: name.text, kind: TYPE_DECLARATIONS.has(declaration.type) ? 'type' : 'value', evidence }];
}

// --- evidence and node helpers ---------------------------------------------

function evidenceFor(node: Node, filePath: string): Evidence {
  return {
    file: filePath,
    line: node.startPosition.row + 1,
    snippet: collapse(node.text),
  };
}

/** One line of display text: newlines and runs of whitespace become single spaces. */
function collapse(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > SNIPPET_MAX_LENGTH ? `${single.slice(0, SNIPPET_MAX_LENGTH)}…` : single;
}

/**
 * Climbs to the statement a nested call belongs to, so that evidence for
 * `const x = require('./y')` shows the assignment rather than the bare call.
 */
function enclosingStatement(node: Node): Node {
  let current: Node = node;
  while (!STATEMENT_TYPES.has(current.type)) {
    const parent: Node | null = current.parent;
    if (parent === null || parent.type === 'program') {
      return current;
    }
    current = parent;
  }
  return current;
}

/** The literal value of a string node, or null if it is not statically known. */
function staticStringValue(node: Node): string | null {
  if (node.type === 'string') {
    return namedChildren(node)
      .filter((child) => child.type === 'string_fragment')
      .map((child) => child.text)
      .join('');
  }

  if (node.type === 'template_string') {
    // Any substitution makes the specifier computed at runtime.
    if (namedChildren(node).some((child) => child.type === 'template_substitution')) {
      return null;
    }
    return namedChildren(node)
      .filter((child) => child.type === 'string_fragment')
      .map((child) => child.text)
      .join('');
  }

  return null;
}

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function namedChildOfType(node: Node, type: string): Node | null {
  return namedChildren(node).find((child) => child.type === type) ?? null;
}

/** Detects keyword tokens such as `type` and `default`, which are unnamed nodes. */
function hasUnnamedChild(node: Node, type: string): boolean {
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child !== null && !child.isNamed && child.type === type) {
      return true;
    }
  }
  return false;
}
