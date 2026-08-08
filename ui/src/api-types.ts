/**
 * Shapes returned by the local JSON API.
 *
 * ARCHITECTURAL RULE 4: ui/ must not import from src/. These declarations are
 * deliberately duplicated rather than shared. The UI is a client of the HTTP
 * API, not a coupled module — if it reached into src/ for a type it would also
 * be reaching into the pipeline's internals, and the boundary would rot the
 * first time something was refactored.
 *
 * They must stay in step with src/server/api.ts by hand. The tradeoff is
 * accepted: a stale type here shows up as a rendering bug in one screen, while
 * a broken boundary shows up everywhere and cannot be undone cheaply.
 */

export type ViewLevel = 'directory' | 'file';

export interface ApiNode {
  id: string;
  kind: 'directory' | 'file';
  path: string;
  label: string;
  fileCount: number;
  languages: Record<string, number>;
  parent: string | null;
  provenance: 'DERIVED' | 'STATED';
}

export interface ApiEdge {
  id: string;
  from: string;
  to: string;
  weight: number;
  importCount: number;
  fileEdges: string[];
  provenance: 'DERIVED' | 'STATED';
}

export interface ApiPosition {
  x: number;
  y: number;
}

export interface GraphResponse {
  level: ViewLevel;
  expanded: string[];
  nodes: ApiNode[];
  edges: ApiEdge[];
  positions: Record<string, ApiPosition>;
  counts: { nodes: number; edges: number; files: number; fileEdges: number };
  expandable: string[];
}

export interface NodeNeighbour {
  id: string;
  weight: number;
  importCount: number;
  edgeId: string;
}

export interface NodeResponse {
  id: string;
  kind: 'directory' | 'file';
  files: string[];
  inbound: NodeNeighbour[];
  outbound: NodeNeighbour[];
  externals: { name: string; count: number }[];
}

export interface EvidenceItem {
  file: string;
  line: number;
  snippet: string;
}

export interface EdgeEvidenceGroup {
  source: string;
  target: string;
  evidence: EvidenceItem[];
}

export interface EdgeResponse {
  id: string;
  from: string;
  to: string;
  weight: number;
  importCount: number;
  groups: EdgeEvidenceGroup[];
}

export interface ModuleNodeSummary {
  id: string;
  kind: 'module';
  /** Mechanical only this week — a shared path prefix or the index. */
  label: string;
  fileCount: number;
  directories: string[];
  /** Files coupling placed here despite them living elsewhere on disk. */
  disagreeingFiles: number;
  provenance: 'DERIVED' | 'STATED';
  llmLabelled: boolean;
}

export interface ModuleEdgeSummary {
  id: string;
  from: string;
  to: string;
  weight: number;
  importCount: number;
  provenance: 'DERIVED' | 'STATED';
}

export interface ModuleViewResponse {
  nodes: ModuleNodeSummary[];
  edges: ModuleEdgeSummary[];
  positions: Record<string, ApiPosition>;
  summary: ClusteringSummary;
  counts: { nodes: number; edges: number; files: number };
}

export type ClusterReason = 'import-coupling' | 'directory-prior' | 'small-cluster-merge';

export interface ModuleDetailResponse {
  id: string;
  label: string;
  directories: string[];
  files: {
    path: string;
    directory: string;
    reason: ClusterReason;
    explanation: string;
    disagrees: boolean;
  }[];
  inbound: NodeNeighbour[];
  outbound: NodeNeighbour[];
}

export interface ClusteringSummary {
  moduleCount: number;
  modularity: number;
  resolution: number;
  seed: number;
  minClusterSize: number;
  mergedClusters: number;
  disagreementRate: number;
  crossDirectoryModules: number;
  splitDirectories: number;
  byReason: Record<string, number>;
  disagreementExamples: {
    file: string;
    directory: string;
    moduleId: string;
    modulePluralityDirectory: string;
  }[];
}

export interface SummaryResponse {
  root: string;
  files: number;
  fileEdges: number;
  imports: { total: number; internal: number; external: number; unresolved: number };
  resolutionRate: number;
  unresolvedByReason: Record<string, number>;
  externalByReason: Record<string, number>;
  unresolvedExamples: { specifier: string; reason: string; file: string; line: number }[];
  parse: {
    filesParsed: number;
    filesFailed: number;
    filesWithSyntaxErrors: number;
    durationMs: number;
  };
  languages: Record<string, number>;
  topExternals: { name: string; count: number }[];
  clustering: ClusteringSummary;
}
