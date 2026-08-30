# Architecture Reference

Technical reference for the Vibe-Code Blueprint pipeline and data model.
Read this when working on pipeline stages, the data model, or the conformance engine.

---

## The pipeline

```
STAGE 1  INGEST / PARSE                          [DETERMINISTIC]
         walk repo, honour .gitignore, detect languages
         tree-sitter per file -> AST -> symbol table
                   |
STAGE 2  GRAPH RESOLUTION                        [DETERMINISTIC]
         resolve imports and calls
         -> file-level dependency graph (nodes + edges)
                   |
STAGE 3  CLUSTERING / LABELLING                  [LLM ASSISTED]
         directory prior + Louvain community detection
         -> candidate modules
         LLM names and describes each module
                   |
STAGE 4  INTENT-CONFORMANCE COMPARISON           [LLM + RULES]
         extract STATED intent (chat logs, AGENTS.md, README, ADRs)
         compile to constraint set
         compare STATED vs DERIVED
         -> ranked violations + drift score
                   |
         RENDER: interactive graph, violation list, drift chart
```

**The determinism boundary sits between Stage 2 and Stage 3.** Everything above it is
reproducible and traceable to source lines. Everything below it involves model judgement and
must be marked as such in the UI.

---

## Data model

```typescript
type Provenance = 'DERIVED' | 'STATED';

interface Node {
  id: string;                    // stable hash of path or module key
  kind: 'file' | 'module' | 'service' | 'layer';
  label: string;                 // human-readable name
  files: string[];               // repo-relative paths
  provenance: Provenance;
  llmLabelled: boolean;          // true if `label` came from a model
  userCorrected: boolean;        // true if the user edited this
}

interface Edge {
  id: string;
  from: string;                  // Node.id
  to: string;                    // Node.id
  kind: 'imports' | 'calls' | 'depends';
  evidence: Evidence[];          // REQUIRED - never create an edge without it
  count: number;                 // number of distinct references
  provenance: Provenance;
}

interface Evidence {
  file: string;                  // repo-relative path
  line: number;
  snippet: string;               // the actual import/call line
}

interface ResolvedSubject {
  phrase: string;                 // the noun phrase exactly as it appeared in the prose
  status: 'MODULE' | 'PATH_PATTERN' | 'REGEX_PATTERN' | 'UNRESOLVED';
  target: string | null;          // module id, glob, or source pattern; null for UNRESOLVED
  origin?: 'prose' | 'regex';     // where the phrase came from
  reason: string | null;          // one of SubjectUnresolvedReason's values; see src/types/constraints.ts
  similarity: number;             // 0-1; 0 when nothing matched
  alternatives: readonly string[];
}

interface Constraint {
  id: string;
  relation: 'must-not-import' | 'may-only-import-via' | 'must-not-cycle'
          | 'must-be-layer-above';
  subject: ResolvedSubject;
  object: ResolvedSubject;
  via: ResolvedSubject | null;   // only meaningful for may-only-import-via; null otherwise
  source: ConstraintSource;
  confidence: number;            // 0-1; extraction certainty
  lowConfidence: boolean;        // below CONFIDENCE_THRESHOLD; recorded and flagged, never dropped
  rawText: string;               // the original sentence it came from, verbatim
  provenance: 'STATED';          // always STATED; no code path produces DERIVED here
}

interface ConstraintSource {
  type: 'chat-log' | 'agents-md' | 'readme' | 'adr' | 'commit-msg' | 'user-authored'
      | 'seeded-from-derived' | 'workflow-edge';
  location: string;              // file path or message id
  line: number | null;           // 1-indexed; null where the source has no lines
  timestamp: string | null;      // ISO 8601; null for plain files
}

interface Violation {
  id: string;
  constraintId: string;
  edgeId: string;
  severity: 'high' | 'medium' | 'low';
  firstSeenCommit: string;
  explanation: string;           // plain-language description
}

interface Snapshot {
  id: string;
  commit: string;
  timestamp: string;
  nodeCount: number;
  edgeCount: number;
  violationCount: number;
  driftScore: number;
}
```

---

## Key algorithms

### Import resolution (Stage 2)

TypeScript/JavaScript:
- Parse `import`, `export ... from`, `require()`, and dynamic `import()`
- Resolve relative paths against the importing file
- Resolve path aliases from `tsconfig.json` `compilerOptions.paths`
- Resolve bare specifiers against `node_modules` — mark these as **external** and exclude
  them from the internal architecture graph by default

Python:
- Parse `import x`, `from x import y`, and relative `from . import y`
- Resolve against the package root (nearest ancestor with `__init__.py`, else repo root)
- Mark standard library and site-packages imports as **external**

**Unresolvable imports must be recorded, not silently dropped.** A high unresolved rate is
itself a useful signal and should be surfaced to the user.

### Clustering (Stage 3)

Run in this order, each refining the previous:

1. **Directory prior** — files in the same directory start in the same candidate cluster.
   People do organise somewhat, and this is free signal.
2. **Louvain community detection** on the import graph — finds actual coupling clusters,
   which often disagree with directory structure. That disagreement is interesting and worth
   surfacing.
3. **Merge heuristics** — collapse clusters below ~3 files into their nearest neighbour.
4. **LLM labelling** — for each cluster, send the file paths, the top exported symbols, and
   2-3 representative snippets. Ask for a short name and a one-line description.
   Never send whole files.

### Drift score (Stage 4)

A single number per snapshot, so it can be charted. Suggested starting formula:

```
driftScore = (weightedViolations / totalConstraints) * 100

weightedViolations = sum over violations of:
    high   -> 3
    medium -> 2
    low    -> 1
```

Keep it simple and explainable. A score the user cannot reason about is worse than no score.
Store the components alongside the total so the UI can break it down.

---

## Storage

SQLite at `.vibe/blueprint.db` (add `.vibe/` to `.gitignore` by default, but allow
`--commit-db` for teams who want shared history).

Tables mirror the data model: `nodes`, `edges`, `evidence`, `constraints`, `violations`,
`snapshots`, `user_corrections`.

**`user_corrections` is important.** When a user merges, splits or renames a cluster, persist
it keyed by a content hash of the cluster's file set. On the next run, reapply corrections
before showing results. Losing user corrections between runs is the fastest way to make the
tool feel useless.

---

## LLM usage rules

- **Three call sites exist:** cluster labelling (Stage 3), intent extraction (Stage 4), and
  ProjectSchema generation (`src/workflow/generate-project-schema.ts`, prompt -> ProjectSchema).
  ProjectSchema generation has no production call site yet (see `docs/ADR-001-*.md`), so the
  degradation rule below is stated as verified for the first two only.
- Labelling and intent extraction must degrade gracefully. If no API key is configured, the
  tool still runs and shows the derived graph with generic cluster names (`module-1`,
  `module-2`). This is important: the deterministic half must be independently useful.
- Cache all responses keyed by input hash. Re-runs on an unchanged repo should cost nothing.
- Every LLM-derived field is marked in the UI with a distinct visual treatment.
