/**
 * Symbol-table types produced by Stage 1b (parsing).
 *
 * These are the input to Stage 2 (graph resolution) in Week 3. Every
 * ImportRecord carries `evidence`, because architectural rule 3 forbids an edge
 * that cannot point at a real file and line — the evidence has to be captured
 * here, at the moment the import is read, or it is gone.
 *
 * Specifiers are RAW and UNRESOLVED. Turning './a' into 'src/a.ts' is Week 3.
 */
import type { Evidence } from './graph.js';
import type { Language } from '../ingest/language.js';

export type ImportKind =
  /** `import ... from '...'` */
  | 'import'
  /** `import type ... from '...'` — erased at runtime, still a real dependency */
  | 'import-type'
  /** `import x = require('...')` — TypeScript's CommonJS interop form */
  | 'import-require'
  /** `require('...')` */
  | 'require'
  /** `import('...')` */
  | 'dynamic-import'
  /** `export ... from '...'` — a re-export is also a dependency */
  | 'export-from';

export interface ImportedName {
  /** The name as exported by the target module. `default` for a default import. */
  readonly name: string;
  /** Local rebinding, or null when imported under its own name. */
  readonly alias: string | null;
  /** True for `import { type A }` — a type-only specifier inside a value import. */
  readonly isType: boolean;
}

export interface ImportRecord {
  /** Raw, unresolved module specifier exactly as written. */
  readonly specifier: string;
  readonly kind: ImportKind;
  /** Empty for side-effect imports, namespace imports and star re-exports. */
  readonly names: readonly ImportedName[];
  /** `import * as ns` or `export * as ns`. */
  readonly isNamespace: boolean;
  /** A default import is present. */
  readonly isDefault: boolean;
  /** `import './x'` — imported purely for effects, binds nothing. */
  readonly isSideEffectOnly: boolean;
  /**
   * File, 1-based line, and the statement's source text with newlines collapsed.
   * Required — see architectural rule 3.
   */
  readonly evidence: Evidence;
}

export type ExportKind =
  /** `export const x`, `export function f`, `export { a }` */
  | 'value'
  /** `export type X`, `export interface I` */
  | 'type'
  /** `export default ...` */
  | 'default'
  /** `export { a } from './m'` */
  | 're-export'
  /** `export * from './m'` — names are not knowable without resolving the target */
  | 'star-re-export';

export interface ExportRecord {
  /** Exported name. `default` for default exports, `*` for star re-exports. */
  readonly name: string;
  readonly kind: ExportKind;
  readonly evidence: Evidence;
}

export interface ParsedFile {
  /** Repo-relative path, forward slashes. */
  readonly path: string;
  readonly language: Language;
  readonly imports: readonly ImportRecord[];
  readonly exports: readonly ExportRecord[];
  /**
   * True when tree-sitter recovered from syntax errors. The file still yields
   * whatever was parseable — partial results beat discarding the file.
   */
  readonly hadSyntaxErrors: boolean;
}

export type ParseFailureReason =
  /** The file could not be read from disk. */
  | 'unreadable'
  /** No grammar and extractor for this extension. */
  | 'unsupported-extension'
  /** The parser threw. Should be rare; tree-sitter recovers from bad syntax. */
  | 'crashed';

export interface ParseFailure {
  readonly path: string;
  readonly reason: ParseFailureReason;
  readonly message: string;
}

export interface SkippedFile {
  readonly path: string;
  readonly language: Language;
  /** Why no symbols were produced. */
  readonly reason: 'no-grammar-yet';
}

export interface ParseReport {
  readonly files: readonly ParsedFile[];
  readonly failures: readonly ParseFailure[];
  /** Files whose language has no parser yet (Python arrives in Week 3). */
  readonly skipped: readonly SkippedFile[];
  readonly durationMs: number;
}
