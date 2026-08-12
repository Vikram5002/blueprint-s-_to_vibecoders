/**
 * tree-sitter grammar loading.
 *
 * The .wasm grammars are vendored at the package root in `grammars/`. Paths are
 * derived from `import.meta.url`, never from the process working directory and
 * never hard-coded — `src/parser/` and `dist/parser/` sit at the same depth, so
 * one relative path serves both the source tree and the build output.
 *
 * Architectural rule 1: this module, and everything else under parser/, must
 * never import from llm/. Parsing is deterministic.
 */
import { fileURLToPath } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';
import { err, ok, type Result } from '../types/result.js';

export type GrammarKey = 'typescript' | 'tsx' | 'javascript' | 'python' | 'php';

export const GRAMMAR_KEYS: readonly GrammarKey[] = [
  'typescript',
  'tsx',
  'javascript',
  'python',
  'php',
];

const GRAMMAR_FILENAMES: Readonly<Record<GrammarKey, string>> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  php: 'tree-sitter-php.wasm',
};

/**
 * The tsx grammar is a superset of typescript and handles JSX; the plain
 * typescript grammar does not. The javascript grammar already covers JSX, so
 * .jsx needs no special case.
 */
const EXTENSION_TO_GRAMMAR: ReadonlyMap<string, GrammarKey> = new Map([
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.py', 'python'],
  ['.php', 'php'],
]);

export interface GrammarLoadError {
  readonly key: GrammarKey;
  readonly path: string;
  readonly message: string;
}

/** Absolute path to a vendored grammar, resolved from this module's location. */
export function grammarPathFor(key: GrammarKey): string {
  return fileURLToPath(new URL(`../../grammars/${GRAMMAR_FILENAMES[key]}`, import.meta.url));
}

export function grammarKeyForPath(filePath: string): GrammarKey | null {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot <= 0) {
    return null;
  }
  return EXTENSION_TO_GRAMMAR.get(filePath.slice(lastDot).toLowerCase()) ?? null;
}

let runtimeInit: Promise<void> | null = null;
const loaded = new Map<GrammarKey, Language>();

/** Initialises the tree-sitter runtime exactly once per process. */
async function initRuntime(): Promise<void> {
  runtimeInit ??= Parser.init();
  await runtimeInit;
}

/** Loads and caches a grammar. Repeated calls return the same Language. */
export async function loadGrammar(key: GrammarKey): Promise<Result<Language, GrammarLoadError>> {
  const cached = loaded.get(key);
  if (cached !== undefined) {
    return ok(cached);
  }

  const path = grammarPathFor(key);
  try {
    await initRuntime();
    const language = await Language.load(path);
    loaded.set(key, language);
    return ok(language);
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({ key, path, message: `could not load ${key} grammar from ${path}: ${message}` });
  }
}
