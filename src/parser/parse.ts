/**
 * Stage 1b: per-file parsing.
 *
 * Holds one tree-sitter Parser per grammar and reuses them across files —
 * creating a parser per file dominates the runtime otherwise.
 *
 * Error tolerance (PHASE-1-SPEC Week 2): a file that cannot be parsed is
 * reported as a failure, never thrown. tree-sitter recovers from broken syntax
 * on its own, so a malformed file normally still yields partial symbols with
 * `hadSyntaxErrors` set rather than failing outright.
 */
import { Parser } from 'web-tree-sitter';
import { err, ok, type Result } from '../types/result.js';
import { detectLanguage } from '../ingest/language.js';
import { extractTypeScriptSymbols } from './extract-ts.js';
import { extractPythonSymbols } from './extract-python.js';
import { extractPhpSymbols } from './extract-php.js';
import { grammarKeyForPath, loadGrammar, type GrammarKey, type GrammarLoadError } from './grammars.js';
import type { ParseFailure, ParsedFile } from '../types/symbols.js';
import type { ExtractedSymbols } from './extract-ts.js';
import type { Node } from 'web-tree-sitter';

/** Grammars with a working extractor. */
export const PARSEABLE_GRAMMARS: readonly GrammarKey[] = [
  'typescript',
  'tsx',
  'javascript',
  'python',
  'php',
];

const EXTRACTORS: Readonly<Record<GrammarKey, (root: Node, filePath: string) => ExtractedSymbols>> = {
  typescript: extractTypeScriptSymbols,
  tsx: extractTypeScriptSymbols,
  javascript: extractTypeScriptSymbols,
  python: extractPythonSymbols,
  php: extractPhpSymbols,
};

export interface ParseInput {
  /** Repo-relative path, forward slashes. Used as evidence, and to pick a grammar. */
  readonly path: string;
  readonly source: string;
}

export interface SourceParser {
  parse(input: ParseInput): Result<ParsedFile, ParseFailure>;
  /** True when this path has both a grammar and an extractor today. */
  supports(path: string): boolean;
  dispose(): void;
}

export async function createSourceParser(): Promise<Result<SourceParser, GrammarLoadError>> {
  const parsers = new Map<GrammarKey, Parser>();

  for (const key of PARSEABLE_GRAMMARS) {
    const grammar = await loadGrammar(key);
    if (!grammar.ok) {
      disposeAll(parsers);
      return err(grammar.error);
    }
    const parser = new Parser();
    parser.setLanguage(grammar.value);
    parsers.set(key, parser);
  }

  return ok({
    supports: (path) => supportsPath(path),
    dispose: () => disposeAll(parsers),
    parse: (input) => parseWith(parsers, input),
  });
}

function supportsPath(path: string): boolean {
  const key = grammarKeyForPath(path);
  return key !== null && PARSEABLE_GRAMMARS.includes(key);
}

function parseWith(parsers: Map<GrammarKey, Parser>, input: ParseInput): Result<ParsedFile, ParseFailure> {
  const key = grammarKeyForPath(input.path);
  const parser = key === null ? undefined : parsers.get(key);
  const language = detectLanguage(input.path);

  if (parser === undefined || language === null || key === null) {
    return err({
      path: input.path,
      reason: 'unsupported-extension',
      message: `no parser for ${input.path}`,
    });
  }

  try {
    const tree = parser.parse(input.source);
    if (tree === null) {
      return err({ path: input.path, reason: 'crashed', message: 'parser returned no tree' });
    }

    try {
      const extract = EXTRACTORS[key];
      const { imports, exports } = extract(tree.rootNode, input.path);
      return ok({
        path: input.path,
        language,
        imports,
        exports,
        hadSyntaxErrors: tree.rootNode.hasError,
      });
    } finally {
      tree.delete();
    }
  } catch (cause: unknown) {
    return err({
      path: input.path,
      reason: 'crashed',
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function disposeAll(parsers: Map<GrammarKey, Parser>): void {
  for (const parser of parsers.values()) {
    parser.delete();
  }
  parsers.clear();
}
