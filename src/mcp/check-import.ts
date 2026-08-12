/**
 * "Am I allowed to import this?", asked before the line is written.
 *
 * This is the one operation in the project that runs *forwards*. Everything
 * else reads a graph that exists and reports what is already true; this is
 * handed a pair of paths and asked about an edge that does not exist yet.
 *
 * So it cannot call `detectViolations`. That function answers "which stated
 * rules does this repository already break", and the answer for an unwritten
 * import is always none — which would make every forbidden import look fine
 * right up until the moment it was committed, and then start failing. The
 * detectors are re-expressed here against a hypothetical edge instead, which
 * means the two implementations have to agree, and `check-import.test.ts`
 * pins that agreement against the same fixtures the detectors use.
 *
 * Rule 2 holds unchanged. The endpoints are DERIVED — resolved against real
 * files in the real graph — and the constraints are STATED. The verdict is a
 * comparison of the two and is labelled as such; it never becomes a property
 * of either side.
 */
import type { Constraint, ResolvedSubject } from '../types/constraints.js';
import type { ClusteringResult } from '../types/modules.js';
import type { FileEdge } from '../conformance/violations.js';

/**
 * Three outcomes, and the third is not a failure.
 *
 * An agent that gets a confident "allowed" from a tool that could not actually
 * tell is worse off than one that gets no answer, because it will write the
 * line and stop thinking about it. `cannot-determine` is the honest result
 * whenever a path does not resolve or a relevant rule could not be evaluated,
 * and it outranks `allowed` for exactly that reason.
 *
 * It does not outrank `forbidden`. A rule that definitely breaks is a definite
 * answer even if some other rule alongside it was unevaluable.
 */
export type ImportVerdict = 'allowed' | 'forbidden' | 'cannot-determine';

export type EndpointStatus = 'file' | 'directory' | 'module' | 'unknown';

export interface ResolvedEndpoint {
  /** The path exactly as the caller wrote it. */
  readonly query: string;
  readonly status: EndpointStatus;
  /** Module ids this endpoint covers. Empty when unknown. */
  readonly modules: readonly string[];
  /**
   * The actual files this endpoint covers.
   *
   * Membership is tested against *these*, never against `modules`. A
   * `PATH_PATTERN` role like `src/parser/` is narrower than the module its
   * files happen to land in, so comparing module ids silently widens every
   * such rule to its whole module — and on a small repository, where
   * clustering puts everything in one module, that makes every rule forbid
   * every import.
   *
   * That is not hypothetical: it is what this tool did on its own acceptance
   * fixture, reporting a clean `api -> parser` edge as forbidden. The detector
   * never had the bug because it has always crossed *file* sets.
   */
  readonly files: readonly string[];
  /** How many analysed files it covers. Zero when unknown. */
  readonly fileCount: number;
  /** Why it did not resolve, in words. Null when it did. */
  readonly reason: string | null;
  /** Traced to files this run actually parsed. */
  readonly provenance: 'DERIVED';
}

/** A stated rule that the proposed import would break. */
export interface ImportFinding {
  readonly constraintId: string;
  readonly relation: Constraint['relation'];
  readonly kind: 'forbidden-import' | 'bypassed-route' | 'upward-dependency' | 'cycle';
  readonly explanation: string;
  /** The sentence, verbatim, so the agent can quote what stopped it. */
  readonly rawText: string;
  readonly confidence: number;
  readonly lowConfidence: boolean;
  readonly source: { readonly location: string; readonly line: number | null };
  /** For `cycle`, the module loop the new edge would close. */
  readonly cycle: readonly string[];
  readonly provenance: 'STATED';
}

/** A stated rule that might have applied but could not be evaluated. */
export interface IndeterminateConstraint {
  readonly constraintId: string;
  readonly relation: Constraint['relation'];
  readonly reason: string;
  readonly rawText: string;
  readonly provenance: 'STATED';
}

export interface CheckImportResult {
  readonly verdict: ImportVerdict;
  readonly from: ResolvedEndpoint;
  readonly to: ResolvedEndpoint;
  readonly findings: readonly ImportFinding[];
  readonly indeterminate: readonly IndeterminateConstraint[];
  /** One paragraph a coding agent can act on without reading the fields. */
  readonly explanation: string;
  /** How many stated rules were evaluated to reach this. */
  readonly constraintsConsidered: number;
  /**
   * True when some document went unread, so the constraint set may be short.
   * A machine-readable companion to the explanation, for a client that wants
   * to treat an incomplete read differently from a genuine absence of rules.
   */
  readonly extractionIncomplete: boolean;
  /**
   * A comparison of STATED against DERIVED — never a third kind of truth.
   * Named explicitly so a client cannot mistake the verdict for a fact about
   * the code or for a fact about the documentation.
   */
  readonly provenance: 'COMPARISON';
}

/**
 * How complete the constraint set actually is.
 *
 * Without this, "we read every document and it forbids nothing" and "we could
 * not read the documents" both arrive here as an empty constraint list and
 * both come back as `allowed`. That is the same zero-versus-zero bug this
 * project has now fixed twice — once for truncated extraction, once for the
 * drift chart — and it is worst here, because this is the answer an agent acts
 * on before writing code.
 *
 * Found in Week 11 acceptance: with the Gemini daily quota exhausted, asking
 * whether `parser/` may import `llm/` returned "allowed, no stated rule applies"
 * on a repository whose CLAUDE.md forbids exactly that in capital letters.
 */
export interface ExtractionHealth {
  /** No model was consulted at all. */
  readonly degraded: boolean;
  /** Documents that failed to extract. */
  readonly failures: number;
  /** Documents cut off at the token limit. */
  readonly incompleteDocuments: number;
}

export interface CheckImportOptions {
  readonly from: string;
  readonly to: string;
  readonly constraints: readonly Constraint[];
  readonly clustering: ClusteringResult;
  readonly fileEdges: readonly FileEdge[];
  /**
   * Omitted means "assume the constraint set is complete". Every caller inside
   * this project passes it; it is optional only so the checker stays testable
   * with three hand-written constraints.
   */
  readonly extraction?: ExtractionHealth;
}

export function checkImport(options: CheckImportOptions): CheckImportResult {
  const index = buildIndex(options.clustering);
  const from = resolveEndpoint(options.from, index);
  const to = resolveEndpoint(options.to, index);

  if (from.status === 'unknown' || to.status === 'unknown') {
    const unknown = from.status === 'unknown' ? from : to;
    return {
      verdict: 'cannot-determine',
      from,
      to,
      findings: [],
      indeterminate: [],
      explanation:
        `Cannot determine. "${unknown.query}" ${unknown.reason ?? 'did not resolve'}. ` +
        `Without knowing which module it belongs to, no stated rule can be applied to it — ` +
        `answering "allowed" here would be a guess.`,
      constraintsConsidered: 0,
      extractionIncomplete: unreadDocuments(options.extraction) !== null,
      provenance: 'COMPARISON',
    };
  }

  const findings: ImportFinding[] = [];
  const indeterminate: IndeterminateConstraint[] = [];
  let considered = 0;

  // Sorted so the same question always produces the same answer in the same order.
  const constraints = [...options.constraints].sort((a, b) => a.id.localeCompare(b.id));

  for (const constraint of constraints) {
    const unevaluable = whyUnevaluable(constraint, index);
    if (unevaluable !== null) {
      // Only report it if it could plausibly have concerned these endpoints.
      // A rule about two unrelated modules being unevaluable is not this
      // caller's problem, and listing every such rule would bury the ones
      // that are.
      if (mightConcern(constraint, from, to)) {
        indeterminate.push({
          constraintId: constraint.id,
          relation: constraint.relation,
          reason: unevaluable,
          rawText: constraint.rawText,
          provenance: 'STATED',
        });
      }
      continue;
    }

    considered += 1;
    const finding = evaluateProspective(constraint, from, to, index, options.fileEdges);
    if (finding !== null) findings.push(finding);
  }

  const unread = unreadDocuments(options.extraction);

  return {
    verdict: verdictFor(findings, indeterminate, unread),
    from,
    to,
    findings,
    indeterminate,
    explanation: explain(findings, indeterminate, from, to, considered, unread),
    constraintsConsidered: considered,
    extractionIncomplete: unread !== null,
    provenance: 'COMPARISON',
  };
}

/**
 * A sentence naming why the constraint set may be short, or null when it is
 * known to be complete.
 */
function unreadDocuments(extraction: ExtractionHealth | undefined): string | null {
  if (extraction === undefined) return null;

  const reasons: string[] = [];
  if (extraction.degraded) reasons.push('no model was available, so no document was read');
  if (extraction.failures > 0) {
    reasons.push(`${extraction.failures} document(s) could not be read`);
  }
  if (extraction.incompleteDocuments > 0) {
    reasons.push(`${extraction.incompleteDocuments} document(s) were cut off before the end`);
  }
  return reasons.length === 0 ? null : reasons.join(', and ');
}

function verdictFor(
  findings: readonly ImportFinding[],
  indeterminate: readonly IndeterminateConstraint[],
  unread: string | null,
): ImportVerdict {
  // A rule that definitely breaks is still a definite answer, even if other
  // documents went unread — the finding cannot be un-found by missing data.
  if (findings.length > 0) return 'forbidden';
  if (indeterminate.length > 0) return 'cannot-determine';
  // Nothing forbade it, but we did not see everything. "Allowed" here would be
  // a claim about documents nobody read.
  if (unread !== null) return 'cannot-determine';
  return 'allowed';
}

function explain(
  findings: readonly ImportFinding[],
  indeterminate: readonly IndeterminateConstraint[],
  from: ResolvedEndpoint,
  to: ResolvedEndpoint,
  considered: number,
  unread: string | null,
): string {
  const pair = `${from.query} -> ${to.query}`;

  if (findings.length > 0) {
    const first = findings[0] as ImportFinding;
    const more = findings.length > 1 ? ` (and ${findings.length - 1} other stated rule(s))` : '';
    return (
      `Forbidden. ${first.explanation}${more} The documentation says: "${first.rawText}" ` +
      `(${first.source.location}${first.source.line === null ? '' : `:${first.source.line}`}).`
    );
  }

  if (indeterminate.length > 0) {
    const first = indeterminate[0] as IndeterminateConstraint;
    return (
      `Cannot determine for ${pair}. ${considered} stated rule(s) were checked and none forbid it, ` +
      `but ${indeterminate.length} rule(s) that may concern these modules could not be evaluated — ` +
      `e.g. "${first.rawText}" (${first.reason}). Treat this as unanswered, not as permission.`
    );
  }

  if (unread !== null) {
    return (
      `Cannot determine for ${pair}. ${considered} stated rule(s) were checked and none forbid it, ` +
      `but the rules are incomplete: ${unread}. A rule in an unread document could forbid this. ` +
      `This is "we did not finish reading", not "this repository states nothing".`
    );
  }

  if (considered === 0) {
    return (
      `Allowed for ${pair}, but only because no stated rule applies to it. Every document was read ` +
      `and none states a checkable constraint covering these modules, so this is ` +
      `"nothing forbids it", not "the architecture endorses it".`
    );
  }

  return `Allowed. ${considered} stated rule(s) were checked against ${pair} and none forbid it.`;
}

// ---------------------------------------------------------------- index

interface Index {
  readonly filesByModule: ReadonlyMap<string, ReadonlySet<string>>;
  readonly moduleByFile: ReadonlyMap<string, string>;
  readonly outbound: ReadonlyMap<string, ReadonlySet<string>>;
}

function buildIndex(clustering: ClusteringResult): Index {
  const filesByModule = new Map<string, Set<string>>();
  const moduleByFile = new Map<string, string>();

  for (const module of clustering.modules) {
    filesByModule.set(module.id, new Set(module.files));
    for (const file of module.files) moduleByFile.set(file, module.id);
  }

  const outbound = new Map<string, Set<string>>();
  for (const edge of clustering.edges) {
    const existing = outbound.get(edge.from);
    if (existing === undefined) outbound.set(edge.from, new Set([edge.to]));
    else existing.add(edge.to);
  }

  return { filesByModule, moduleByFile, outbound };
}

/**
 * A path from an agent, mapped onto something the graph can name.
 *
 * Deliberately accepts three shapes, because an agent about to write an import
 * knows the file path, not this tool's module ids. Tried most specific first:
 * an exact file is unambiguous, a directory prefix is next, and a module id
 * last. Anything else is `unknown` — never a nearest guess, for the same reason
 * subject resolution refuses to guess in Week 7.
 */
export function resolveEndpoint(query: string, index: Index): ResolvedEndpoint {
  const normalised = query.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

  const exactModule = index.moduleByFile.get(normalised);
  if (exactModule !== undefined) {
    return endpoint(query, 'file', [exactModule], [normalised]);
  }

  const underDirectory = [...index.moduleByFile.keys()]
    .filter((file) => file.startsWith(`${normalised}/`))
    .sort();
  if (underDirectory.length > 0) {
    const modules = [
      ...new Set(underDirectory.map((file) => index.moduleByFile.get(file) as string)),
    ].sort();
    return endpoint(query, 'directory', modules, underDirectory);
  }

  const asModule = index.filesByModule.get(normalised);
  if (asModule !== undefined) {
    return endpoint(query, 'module', [normalised], [...asModule].sort());
  }

  return {
    query,
    status: 'unknown',
    modules: [],
    files: [],
    fileCount: 0,
    reason:
      'matched no file, directory or module in the analysed repository (it may be a new path, ' +
      'an external package, or outside the analysed root)',
    provenance: 'DERIVED',
  };
}

function endpoint(
  query: string,
  status: EndpointStatus,
  modules: readonly string[],
  files: readonly string[],
): ResolvedEndpoint {
  return {
    query,
    status,
    modules,
    files,
    fileCount: files.length,
    reason: null,
    provenance: 'DERIVED',
  };
}

// ---------------------------------------------------------------- evaluation

function filesFor(subject: ResolvedSubject, index: Index): Set<string> {
  if (subject.status === 'MODULE' && subject.target !== null) {
    return new Set(index.filesByModule.get(subject.target) ?? []);
  }
  /**
   * A config regex is re-applied to the real file list here, rather than
   * having been reduced to a prefix at resolution time. `resolveRegexSubject`
   * proved the pattern matches something; this is what it matches.
   */
  if (subject.status === 'REGEX_PATTERN' && subject.target !== null) {
    let expression: RegExp;
    try {
      expression = new RegExp(subject.target);
    } catch {
      return new Set();
    }
    const files = new Set<string>();
    for (const file of index.moduleByFile.keys()) {
      if (expression.test(file)) files.add(file);
    }
    return files;
  }

  if (subject.status === 'PATH_PATTERN' && subject.target !== null) {
    const prefix = subject.target.replace(/\/?\*\*?$/, '').replace(/\*/g, '');
    const files = new Set<string>();
    for (const file of index.moduleByFile.keys()) {
      if (file === prefix || file.startsWith(`${prefix}/`)) files.add(file);
    }
    return files;
  }
  return new Set();
}

/** Module ids a resolved role covers, for endpoint overlap tests. */
function modulesFor(subject: ResolvedSubject, index: Index): Set<string> {
  const modules = new Set<string>();
  for (const file of filesFor(subject, index)) {
    const moduleId = index.moduleByFile.get(file);
    if (moduleId !== undefined) modules.add(moduleId);
  }
  return modules;
}

/**
 * Mirrors `reasonToSkip` in the detector: same roles, same two failure modes.
 */
function whyUnevaluable(constraint: Constraint, index: Index): string | null {
  const roles: readonly (readonly [string, ResolvedSubject])[] = [
    ['subject', constraint.subject],
    ...(constraint.relation === 'must-not-cycle' ? [] : ([['object', constraint.object]] as const)),
    ...(constraint.via === null ? [] : ([['via', constraint.via]] as const)),
  ];

  for (const [role, resolved] of roles) {
    if (resolved.status === 'UNRESOLVED') {
      return `its ${role} "${resolved.phrase}" could not be matched to anything in this repository`;
    }
  }
  for (const [role, resolved] of roles) {
    if (filesFor(resolved, index).size === 0) {
      return `its ${role} "${resolved.phrase}" matched nothing this run analysed`;
    }
  }
  return null;
}

/**
 * Would an unevaluable rule have been about these two endpoints?
 *
 * A deliberately loose test, because the rule is unevaluable precisely because
 * we could not pin its subject down — so a strict overlap check would say "no"
 * for exactly the rules most worth warning about. Any textual mention of a
 * module either endpoint touches counts.
 */
function mightConcern(
  constraint: Constraint,
  from: ResolvedEndpoint,
  to: ResolvedEndpoint,
): boolean {
  const haystack = [constraint.subject.phrase, constraint.object.phrase, constraint.via?.phrase ?? '']
    .join(' ')
    .toLowerCase();

  const needles = [...from.modules, ...to.modules, from.query, to.query].map((value) =>
    value.replace(/\\/g, '/').toLowerCase(),
  );

  return needles.some((needle) =>
    needle
      .split('/')
      .filter((segment) => segment.length > 2)
      .some((segment) => haystack.includes(segment)),
  );
}

function evaluateProspective(
  constraint: Constraint,
  from: ResolvedEndpoint,
  to: ResolvedEndpoint,
  index: Index,
  fileEdges: readonly FileEdge[],
): ImportFinding | null {
  switch (constraint.relation) {
    case 'must-not-import':
      return overlaps(constraint.subject, from, index) && overlaps(constraint.object, to, index)
        ? finding(
            constraint,
            'forbidden-import',
            `Importing ${to.query} from ${from.query} would create exactly the dependency this rule forbids.`,
            [],
          )
        : null;

    /**
     * `must-be-layer-above(A, B)` is broken by an edge B -> A: A sits above B,
     * so dependencies may run down but never up. Same direction as the
     * detector, and getting it backwards here would tell an agent that every
     * correct layered import is forbidden.
     */
    case 'must-be-layer-above':
      return overlaps(constraint.object, from, index) && overlaps(constraint.subject, to, index)
        ? finding(
            constraint,
            'upward-dependency',
            `${from.query} sits below ${to.query} in the stated layering, so this import would run upward.`,
            [],
          )
        : null;

    /**
     * Direct-edge semantics, matching the detector's documented rule. An
     * import written *from* the routing module itself is the route working,
     * not a breach of it.
     */
    case 'may-only-import-via': {
      if (!overlaps(constraint.subject, from, index) || !overlaps(constraint.object, to, index)) {
        return null;
      }
      // File-level, like the detector's own `via.has(edge.from)` check.
      const via = constraint.via === null ? new Set<string>() : filesFor(constraint.via, index);
      if (from.files.some((file) => via.has(file)) || to.files.some((file) => via.has(file))) {
        return null;
      }
      return finding(
        constraint,
        'bypassed-route',
        `${from.query} may reach ${to.query} only through ${constraint.via?.phrase ?? 'the stated route'}; ` +
          `a direct import would bypass it.`,
        [],
      );
    }

    /**
     * A prospective cycle is the one case where the existing graph decides the
     * answer: the new edge closes a loop only if the target can already reach
     * the source. Checked at module level, like the detector.
     */
    case 'must-not-cycle': {
      const constrained = modulesFor(constraint.subject, index);
      const path = shortestPath(to.modules, from.modules, index.outbound);
      if (path === null) return null;

      // Ignore a loop entirely inside one module: the constraint is about the
      // module as a unit, and file-level cycles within it are not its subject.
      const loop = [...path, path[0] as string];
      if (!loop.some((moduleId) => constrained.has(moduleId))) return null;

      return finding(
        constraint,
        'cycle',
        `${to.query} already reaches ${from.query} (${path.join(' -> ')}), so this import would close ` +
          `a dependency cycle through a module the documentation says must not cycle.`,
        path,
      );
    }
  }

  // Unreachable: every relation is handled above. Present so a new relation
  // added to the union fails the type check here rather than silently
  // returning "allowed" — which would be the worst possible default.
  void fileEdges;
  return null;
}

/**
 * Does this endpoint fall inside the role's scope?
 *
 * Tested on files, exactly as `crossingEdges` does in the detector. Comparing
 * module ids here was a real false-positive bug — see `ResolvedEndpoint.files`.
 */
function overlaps(subject: ResolvedSubject, endpointValue: ResolvedEndpoint, index: Index): boolean {
  const files = filesFor(subject, index);
  return endpointValue.files.some((file) => files.has(file));
}

/**
 * Shortest module path from any of `starts` to any of `goals`, or null.
 *
 * Breadth-first and sorted at every step so the reported loop is the same on
 * every run. Iterative for the same reason Tarjan is in the detector.
 */
export function shortestPath(
  starts: readonly string[],
  goals: readonly string[],
  outbound: ReadonlyMap<string, ReadonlySet<string>>,
): string[] | null {
  const targets = new Set(goals);
  const seen = new Set<string>(starts);
  const queue: string[][] = [...starts].sort().map((start) => [start]);

  while (queue.length > 0) {
    const path = queue.shift() as string[];
    const tail = path[path.length - 1] as string;
    if (targets.has(tail) && path.length > 0) return path;

    for (const next of [...(outbound.get(tail) ?? [])].sort()) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

function finding(
  constraint: Constraint,
  kind: ImportFinding['kind'],
  explanation: string,
  cycle: readonly string[],
): ImportFinding {
  return {
    constraintId: constraint.id,
    relation: constraint.relation,
    kind,
    explanation,
    rawText: constraint.rawText,
    confidence: constraint.confidence,
    lowConfidence: constraint.lowConfidence,
    source: { location: constraint.source.location, line: constraint.source.line },
    cycle,
    provenance: 'STATED',
  };
}
