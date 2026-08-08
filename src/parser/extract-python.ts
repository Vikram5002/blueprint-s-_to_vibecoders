/**
 * Python symbol extraction.
 *
 * Pure: parsed tree in, records out. Specifiers stay raw and unresolved.
 *
 * Relative imports keep their dot count in `relativeLevel` rather than in the
 * specifier. `from ..pkg import x` becomes specifier `pkg`, level 2. The
 * resolver needs the level, and once the dots are folded into a string there is
 * no way to tell `..pkg` from a module genuinely named `..pkg`.
 *
 * Python has no export statements — a module's public surface is every
 * top-level binding, optionally narrowed by `__all__`. That is a different
 * question from "what does this file depend on", and Week 3 only needs imports,
 * so exports are deliberately left empty.
 */
import type { Node } from 'web-tree-sitter';
import type { Evidence } from '../types/graph.js';
import type { ImportRecord, ImportedName } from '../types/symbols.js';
import type { ExtractedSymbols } from './extract-ts.js';

const SNIPPET_MAX_LENGTH = 240;

export function extractPythonSymbols(root: Node, filePath: string): ExtractedSymbols {
  const imports: ImportRecord[] = [];

  for (const node of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
    if (node === null) {
      continue;
    }
    if (node.type === 'import_statement') {
      collectImport(node, filePath, imports);
    } else {
      collectFromImport(node, filePath, imports);
    }
  }

  return { imports, exports: [] };
}

/**
 * `import a, b.c, d as e` carries several `name` fields on one statement and is
 * three separate dependencies, so it becomes three records sharing one evidence.
 */
function collectImport(node: Node, filePath: string, out: ImportRecord[]): void {
  const evidence = evidenceFor(node, filePath);

  for (const target of node.childrenForFieldName('name')) {
    if (target === null) {
      continue;
    }
    const { module, alias } = moduleAndAlias(target);
    if (module === null) {
      continue;
    }

    out.push({
      specifier: module,
      kind: 'python-import',
      relativeLevel: 0,
      names: [{ name: module, alias, isType: false }],
      isNamespace: false,
      isDefault: false,
      isSideEffectOnly: false,
      evidence,
    });
  }
}

function collectFromImport(node: Node, filePath: string, out: ImportRecord[]): void {
  const moduleNode = node.childForFieldName('module_name');
  if (moduleNode === null) {
    return;
  }

  const { specifier, relativeLevel } = fromModule(moduleNode);
  if (specifier === null) {
    return;
  }

  const wildcard = namedChildOfType(node, 'wildcard_import') !== null;

  out.push({
    specifier,
    kind: 'python-from',
    relativeLevel,
    names: wildcard ? [{ name: '*', alias: null, isType: false }] : importedNames(node),
    isNamespace: wildcard,
    isDefault: false,
    isSideEffectOnly: false,
    evidence: evidenceFor(node, filePath),
  });
}

/** Splits `relative_import` into its dot count and its dotted remainder. */
function fromModule(moduleNode: Node): { specifier: string | null; relativeLevel: number } {
  if (moduleNode.type === 'dotted_name') {
    return { specifier: moduleNode.text, relativeLevel: 0 };
  }

  if (moduleNode.type !== 'relative_import') {
    return { specifier: null, relativeLevel: 0 };
  }

  const prefix = namedChildOfType(moduleNode, 'import_prefix');
  const dotted = namedChildOfType(moduleNode, 'dotted_name');

  return {
    // `from . import x` has a prefix and no remainder: the package itself.
    specifier: dotted?.text ?? '',
    relativeLevel: prefix === null ? 0 : countDots(prefix.text),
  };
}

function countDots(text: string): number {
  let dots = 0;
  for (const character of text) {
    if (character === '.') {
      dots += 1;
    }
  }
  return dots;
}

function importedNames(node: Node): ImportedName[] {
  const names: ImportedName[] = [];

  for (const target of node.childrenForFieldName('name')) {
    if (target === null) {
      continue;
    }
    const { module, alias } = moduleAndAlias(target);
    if (module !== null) {
      names.push({ name: module, alias, isType: false });
    }
  }

  return names;
}

/** Unwraps `aliased_import` into the module text and its alias. */
function moduleAndAlias(target: Node): { module: string | null; alias: string | null } {
  if (target.type === 'dotted_name') {
    return { module: target.text, alias: null };
  }

  if (target.type === 'aliased_import') {
    const name = target.childForFieldName('name');
    return {
      module: name?.text ?? null,
      alias: target.childForFieldName('alias')?.text ?? null,
    };
  }

  return { module: null, alias: null };
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
