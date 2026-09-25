/**
 * Mirrors src/server/projects-api.ts's response shapes, hand-duplicated for
 * rule 4 (ui/ must not import from src/), like every other mirror file here.
 */

export type ProjectSource =
  | { readonly kind: 'home' }
  | { readonly kind: 'local'; readonly path: string }
  | {
      readonly kind: 'git';
      readonly url: string;
      readonly branch: string;
      readonly commit: string;
    };

export type JobStatus = 'idle' | 'cloning' | 'analysing' | 'succeeded' | 'failed';

export interface ProjectJob {
  readonly status: JobStatus;
  readonly target: string;
  readonly message: string;
  readonly percent?: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface CurrentProject {
  readonly root: string;
  readonly isHome: boolean;
  readonly source: ProjectSource;
  readonly job: ProjectJob;
}

export interface RecentProject {
  readonly label: string;
  readonly source: Exclude<ProjectSource, { kind: 'home' }>;
  readonly analysedAt: string;
}

export interface BrowseEntry {
  readonly name: string;
  readonly path: string;
}

export interface BrowseResponse {
  /** Empty for the starting list (drives on Windows, the home folder elsewhere). */
  readonly path: string;
  /** Empty when `path` is a drive root; null for the starting list. */
  readonly parent: string | null;
  readonly entries: readonly BrowseEntry[];
}

export type AnalyseRequest =
  | { readonly kind: 'local'; readonly path: string; readonly modelLabels: boolean }
  | {
      readonly kind: 'git';
      readonly url: string;
      readonly branch: string;
      readonly modelLabels: boolean;
    };
