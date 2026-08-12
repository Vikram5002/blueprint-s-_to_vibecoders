/**
 * Import resolution outcomes.
 *
 * Every import lands in exactly one of three states. The distinction between
 * EXTERNAL and UNRESOLVED is the important one: EXTERNAL means we positively
 * identified the target as a package outside the repository, which is a
 * success. UNRESOLVED means we could not tell. Classifying a failure as
 * EXTERNAL would inflate the resolution rate and hide resolver bugs, which is
 * exactly the metric's blind spot, so the reason codes below stay narrow and
 * every one of them records why.
 */
import type { ImportRecord } from './symbols.js';

export type ResolutionStatus = 'INTERNAL' | 'EXTERNAL' | 'UNRESOLVED';

export type ExternalReason =
  /** Bare specifier that is not a workspace package: an npm dependency. */
  | 'npm-package'
  /** Matched the Python standard library module list. */
  | 'python-stdlib'
  /** A Python top-level module that is not stdlib and not in the repo. */
  | 'python-site-packages'
  /** `node:fs` and friends. */
  | 'node-builtin'
  /** A PHP FQCN matching no registered PSR-4 prefix, or a require path under `vendor/`. */
  | 'php-composer-package';

export type UnresolvedReason =
  /** Relative path that pointed at no file on disk. */
  | 'relative-target-missing'
  /** A tsconfig `paths` alias matched but its target does not exist. */
  | 'alias-target-missing'
  /** A Python relative import climbed past the package root. */
  | 'relative-beyond-root'
  /** A Python module that looks internal but no matching file was found. */
  | 'python-module-missing'
  /** Resolved to a file the walker never saw (ignored, or an unsupported type). */
  | 'target-not-in-repo'
  /** A PHP `use` FQCN matched a PSR-4 prefix but no file exists at the mapped path. */
  | 'php-namespace-target-missing'
  /** A PHP `require`/`include` literal path pointed at no file on disk. */
  | 'php-require-target-missing';

export interface ResolvedImport {
  /** The import this outcome belongs to. */
  readonly record: ImportRecord;
  readonly status: ResolutionStatus;
  /**
   * Repo-relative path of the target file. Present only for INTERNAL.
   */
  readonly targetPath: string | null;
  /**
   * For EXTERNAL, the package or module name we identified (`react`,
   * `os.path`). Null otherwise.
   */
  readonly externalName: string | null;
  readonly reason: ExternalReason | UnresolvedReason | null;
}

export interface ResolutionSummary {
  readonly total: number;
  readonly internal: number;
  readonly external: number;
  readonly unresolved: number;
  /** 1 - (unresolved / total), as a percentage. 100 when there are no imports. */
  readonly resolutionRate: number;
  /** Unresolved counts keyed by reason — this grouping is how you debug. */
  readonly unresolvedByReason: Readonly<Partial<Record<UnresolvedReason, number>>>;
  readonly externalByReason: Readonly<Partial<Record<ExternalReason, number>>>;
}
