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

/** Rule 2's three states. Each must be visually distinct on screen. */
export type LabelSource = 'mechanical' | 'llm' | 'user';

export interface ModuleNodeSummary {
  id: string;
  /** What to show. May be mechanical, model-supplied, or user-written. */
  label: string;
  kind: 'module';
  labelSource: LabelSource;
  /** The deterministic name, always kept, so the derived answer stays visible. */
  mechanicalLabel: string;
  description: string | null;
  fileCount: number;
  directories: string[];
  /** Files coupling placed here despite them living elsewhere on disk. */
  disagreeingFiles: number;
  provenance: 'DERIVED' | 'STATED';
  llmLabelled: boolean;
}

export type CorrectionKind = 'rename' | 'merge' | 'split';
export type CorrectionStatus = 'applied' | 'applied-with-drift' | 'orphaned' | 'pending';

export interface CorrectionSummary {
  id: string;
  kind: CorrectionKind;
  label: string | null;
  members: string[];
  sides: { label: string; files: string[] }[];
  createdAt: string;
  status: CorrectionStatus;
  overlap: number;
  /** Files that joined the module since the correction was made. */
  joined: string[];
  /** Files that left it. */
  left: string[];
  /** Split only: files no side claims, deliberately placed nowhere. */
  unresolved: string[];
  explanation: string;
}

export interface CorrectionsResponse {
  corrections: CorrectionSummary[];
  summary: {
    total: number;
    applied: number;
    drifted: number;
    orphaned: number;
    unresolvedFiles: number;
  };
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

/**
 * STATED data. Kept in its own response, and its own types, so nothing in the
 * graph views can render a claim by accident (rule 2).
 */
export interface ConstraintRole {
  phrase: string;
  status: 'MODULE' | 'PATH_PATTERN' | 'UNRESOLVED';
  target: string | null;
  reason: string | null;
  similarity: number;
}

export interface ConstraintResponse {
  id: string;
  relation: string;
  subject: ConstraintRole;
  object: ConstraintRole;
  via: ConstraintRole | null;
  confidence: number;
  lowConfidence: boolean;
  evaluable: boolean;
  rawText: string;
  source: { type: string; location: string; line: number | null; timestamp: string | null };
  provenance: 'STATED';
}

export interface IntentResponse {
  degraded: boolean;
  summary: {
    documents: number;
    architecturalStatements: number;
    constraints: number;
    uncheckable: number;
    byUncheckableReason: Record<string, number>;
    byRelation: Record<string, number>;
    lowConfidence: number;
    evaluable: number;
    subjects: {
      total: number;
      module: number;
      pathPattern: number;
      unresolved: number;
      resolutionRate: number;
      byReason: Record<string, number>;
    };
    degraded: boolean;
  };
  constraints: ConstraintResponse[];
  uncheckable: { rawText: string; reason: string; location: string }[];
  failures: { location: string; reason: string }[];
  emptyReason: 'not-attempted' | 'no-documents' | 'nothing-stated' | null;
}

/** Week 9: snapshots, diffs and drift over time. */
export interface DiffEntryResponse {
  kind: string;
  key: string;
  description: string;
  evidence: string[];
}

export interface SnapshotDiffBody {
  from: { commit: string; subject: string };
  to: { commit: string; subject: string };
  entries: DiffEntryResponse[];
  summary: {
    total: number;
    byKind: Record<string, number>;
    comparable: boolean;
    comparabilityNote: string;
    driftBefore: number;
    driftAfter: number;
    driftDelta: number;
  };
}

export type DiffResponse =
  | { ok: true; diff: SnapshotDiffBody }
  | { ok: false; reason: string; available: string[] };

export interface DriftPointResponse {
  commit: string;
  shortCommit: string;
  committedAt: string;
  subject: string;
  score: number;
  delta: number;
  fileCount: number;
  moduleCount: number;
  edgeCount: number;
  violationCount: number;
  constraintCount: number;
  causes: string[];
  changeCount: number;
}

export type DriftHistoryResponse =
  | {
      ok: true;
      history: {
        points: DriftPointResponse[];
        summary: {
          commits: number;
          first: number;
          last: number;
          peak: number;
          trough: number;
          movingSteps: number;
          structuralOnlySteps: number;
          note: string;
        };
      };
    }
  | { ok: false; reason: string };

/** Week 10: violations and one stored snapshot, both read-only projections. */
export interface ViolationEdgeResponse {
  edgeId: string;
  fromFile: string;
  toFile: string;
  fromModule: string;
  toModule: string;
  importCount: number;
  evidence: { file: string; line: number; snippet: string }[];
}

export interface ViolationResponse {
  id: string;
  constraintId: string;
  kind: string;
  severity: 'high' | 'medium' | 'low';
  severityScore: number;
  severityFactors: string[];
  explanation: string;
  cycle: string[];
  edges: ViolationEdgeResponse[];
  constraint: {
    relation: string;
    subject: string;
    object: string;
    via: string | null;
    rawText: string;
    confidence: number;
    lowConfidence: boolean;
    provenance: 'STATED';
    source: { type: string; location: string; line: number | null };
  };
}

export interface ViolationsResponse {
  violations: ViolationResponse[];
  unchecked: { constraintId: string; reason: string; explanation: string; rawText: string; source: string }[];
  summary: {
    constraints: number;
    checked: number;
    satisfied: number;
    unchecked: number;
    violated: number;
    violations: number;
    bySeverity: Record<'high' | 'medium' | 'low', number>;
    implicatedEdges: number;
  };
  emptyReason: 'no-constraints' | 'all-unchecked' | 'all-satisfied' | null;
  uncheckableStatements: { total: number; byReason: Record<string, number>; documents: number };
  drift: { score: number; explanation: string };
}

export interface SnapshotBody {
  commit: string;
  committedAt: string;
  subject: string;
  fileCount: number;
  moduleCount: number;
  edgeCount: number;
  violationCount: number;
  violations: { id: string; severity: 'high' | 'medium' | 'low'; explanation: string; kind: string }[];
  drift: { score: number; explanation: string };
}

export type SnapshotResponse = { ok: true; snapshot: SnapshotBody } | { ok: false; reason: string };
