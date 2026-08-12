/**
 * Comparing STATED constraints against the DERIVED graph.
 *
 * Fully deterministic and offline. It does not import from `llm/` and must not:
 * deciding whether an edge breaks a rule is graph traversal, not judgement, and
 * a violation that depended on a model would be unreproducible in exactly the
 * way that destroys trust in a conformance report.
 *
 * Nothing here creates an edge or a constraint. It reads both and reports where
 * they disagree.
 */
import { createHash } from 'node:crypto';
import { scoreSeverity } from './severity.js';
import type { Constraint, ResolvedSubject } from '../types/constraints.js';
import type { ModuleEdge, ClusteringResult } from '../types/modules.js';
import type { Evidence } from '../types/graph.js';
import type {
  ConformanceResult,
  Severity,
  UncheckedConstraint,
  UncheckedReason,
  Violation,
  ViolatingEdge,
  ViolationKind,
  ViolationSummary,
} from '../types/violations.js';

/** A file-level edge, flattened out of the graph so this module stays graph-library-free. */
export interface FileEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly importCount: number;
  readonly evidence: readonly Evidence[];
  readonly provenance: string;
}

export interface DetectOptions {
  readonly constraints: readonly Constraint[];
  readonly clustering: ClusteringResult;
  readonly fileEdges: readonly FileEdge[];
  /**
   * Unresolved import counts per file, so severity can discount a violation
   * found in a corner of the repository the resolver only partly read.
   */
  readonly unresolvedByFile?: ReadonlyMap<string, number>;
}

export function detectViolations(options: DetectOptions): ConformanceResult {
  const index = buildIndex(options);
  const violations: Violation[] = [];
  const unchecked: UncheckedConstraint[] = [];

  // Sorted so the output never depends on the order constraints arrived in.
  const constraints = [...options.constraints].sort((a, b) => a.id.localeCompare(b.id));

  for (const constraint of constraints) {
    const skip = reasonToSkip(constraint, index);
    if (skip !== null) {
      unchecked.push({ constraintId: constraint.id, ...skip, constraint });
      continue;
    }

    const found = evaluate(constraint, index);
    violations.push(...found);
  }

  violations.sort((a, b) => a.id.localeCompare(b.id));
  return { violations, unchecked, summary: summarise(constraints, violations, unchecked) };
}

// ---------------------------------------------------------------- indexing

interface Index {
  /** Module id -> the files in it. */
  readonly filesByModule: ReadonlyMap<string, ReadonlySet<string>>;
  /** File path -> module id. */
  readonly moduleByFile: ReadonlyMap<string, string>;
  readonly fileEdges: readonly FileEdge[];
  readonly moduleEdges: readonly ModuleEdge[];
  /** Module id -> module ids it imports. */
  readonly outbound: ReadonlyMap<string, ReadonlySet<string>>;
  readonly unresolvedByFile: ReadonlyMap<string, number>;
  readonly importsByFile: ReadonlyMap<string, number>;
}

function buildIndex(options: DetectOptions): Index {
  const filesByModule = new Map<string, Set<string>>();
  const moduleByFile = new Map<string, string>();

  for (const module of options.clustering.modules) {
    const files = new Set(module.files);
    filesByModule.set(module.id, files);
    for (const file of module.files) moduleByFile.set(file, module.id);
  }

  const outbound = new Map<string, Set<string>>();
  for (const edge of options.clustering.edges) {
    const existing = outbound.get(edge.from);
    if (existing === undefined) outbound.set(edge.from, new Set([edge.to]));
    else existing.add(edge.to);
  }

  const importsByFile = new Map<string, number>();
  for (const edge of options.fileEdges) {
    importsByFile.set(edge.from, (importsByFile.get(edge.from) ?? 0) + edge.importCount);
  }

  return {
    filesByModule,
    moduleByFile,
    fileEdges: options.fileEdges,
    moduleEdges: options.clustering.edges,
    outbound,
    unresolvedByFile: options.unresolvedByFile ?? new Map(),
    importsByFile,
  };
}

/**
 * Expands a resolved subject into the set of files it covers.
 *
 * A subject is either one module or a path glob, and both end up as a file set,
 * so the detectors do not have to care which kind they were given.
 */
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

function reasonToSkip(
  constraint: Constraint,
  index: Index,
): { reason: UncheckedReason; explanation: string } | null {
  const roles: readonly (readonly [string, ResolvedSubject])[] = [
    ['subject', constraint.subject],
    ...(constraint.relation === 'must-not-cycle'
      ? []
      : ([['object', constraint.object]] as const)),
    ...(constraint.via === null ? [] : ([['via', constraint.via]] as const)),
  ];

  for (const [role, resolved] of roles) {
    if (resolved.status === 'UNRESOLVED') {
      return {
        reason: 'unresolved-role',
        explanation: `The ${role} "${resolved.phrase}" could not be matched to anything in this repository (${resolved.reason ?? 'no reason recorded'}), so this rule cannot be checked.`,
      };
    }
  }

  for (const [role, resolved] of roles) {
    if (filesFor(resolved, index).size === 0) {
      return {
        reason: 'empty-target',
        explanation: `The ${role} "${resolved.phrase}" matched ${resolved.target ?? 'a target'}, which contains no files this run analysed, so there is nothing to check against.`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------- detectors

function evaluate(constraint: Constraint, index: Index): Violation[] {
  switch (constraint.relation) {
    case 'must-not-import':
      return detectForbiddenImports(constraint, index);
    case 'must-be-layer-above':
      return detectUpwardDependencies(constraint, index);
    case 'may-only-import-via':
      return detectBypassedRoute(constraint, index);
    case 'must-not-cycle':
      return detectCycles(constraint, index);
  }
}

/** Every file edge whose source is in `from` and whose target is in `to`. */
function crossingEdges(from: ReadonlySet<string>, to: ReadonlySet<string>, index: Index): FileEdge[] {
  return index.fileEdges
    .filter((edge) => from.has(edge.from) && to.has(edge.to))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function detectForbiddenImports(constraint: Constraint, index: Index): Violation[] {
  const subject = filesFor(constraint.subject, index);
  const object = filesFor(constraint.object, index);
  const edges = crossingEdges(subject, object, index);
  if (edges.length === 0) return [];

  return [
    build(constraint, 'forbidden-import', edges, index, [], (count, files) =>
      `${describe(constraint.subject)} imports ${describe(constraint.object)} in ${files} file(s), ` +
      `across ${count} import statement(s). The documentation says it must not.`,
    ),
  ];
}

/**
 * `must-be-layer-above(A, B)` is broken by an edge **B -> A**, not A -> B.
 *
 * A sitting above B means A is allowed to depend on B; dependencies run
 * downward. The violation is the upward one, and getting this backwards would
 * flag every correct layered design as broken — which is exactly the kind of
 * confident, systematic false positive that makes a conformance tool worthless.
 */
function detectUpwardDependencies(constraint: Constraint, index: Index): Violation[] {
  const above = filesFor(constraint.subject, index);
  const below = filesFor(constraint.object, index);
  const edges = crossingEdges(below, above, index);
  if (edges.length === 0) return [];

  return [
    build(constraint, 'upward-dependency', edges, index, [], (count, files) =>
      `${describe(constraint.object)} imports ${describe(constraint.subject)} in ${files} file(s), ` +
      `across ${count} import statement(s), but the documentation puts ` +
      `${describe(constraint.subject)} above it — dependencies should run the other way.`,
    ),
  ];
}

/**
 * `may-only-import-via(A, B, C)`: A may reach B, but only through C.
 *
 * ## The rule, decided and stated
 *
 * **A violation is any direct file edge from A to B. Nothing else.**
 *
 * The brief asks whether checking C itself is also required. It is not, and
 * deliberately:
 *
 * 1. **Whether C also violates something is a separate constraint's job.** If
 *    the documentation cares that C must not reach B, it will say so, and that
 *    sentence becomes its own constraint with its own confidence and its own
 *    evidence. Folding that check in here would report one finding built from
 *    two rules, and a user could not tell which sentence to argue with.
 * 2. **A -> C -> B is the routing working, not a violation.** That is what the
 *    constraint asked for. Reporting a transitive reach through the permitted
 *    route would flag the intended design.
 * 3. **Transitive reachability is nearly always true in a real graph and says
 *    almost nothing.** In pyright, most modules reach most other modules through
 *    some chain. A check that fires on "A can eventually reach B somehow" is a
 *    check that fires constantly, and a finding that is always true carries no
 *    information.
 *
 * So the semantics are *direct-edge*, and the cost of that choice is stated
 * plainly: this will not catch a laundering module that exists only to relay A's
 * imports to B while technically satisfying the letter of the rule. Catching
 * that needs a rule about C, and the honest place for it is a constraint about
 * C, not a cleverer reading of this one.
 *
 * `A -> C` and `C -> B` are both left alone regardless of whether C actually
 * routes anything.
 */
function detectBypassedRoute(constraint: Constraint, index: Index): Violation[] {
  const subject = filesFor(constraint.subject, index);
  const object = filesFor(constraint.object, index);
  const via = constraint.via === null ? new Set<string>() : filesFor(constraint.via, index);

  // Direct edges only, and never count the permitted route as a breach: a file
  // that is itself part of C is allowed to reach B.
  const edges = crossingEdges(subject, object, index).filter(
    (edge) => !via.has(edge.from) && !via.has(edge.to),
  );
  if (edges.length === 0) return [];

  return [
    build(constraint, 'bypassed-route', edges, index, [], (count, files) =>
      `${describe(constraint.subject)} imports ${describe(constraint.object)} directly in ${files} file(s), ` +
      `across ${count} import statement(s), bypassing ${describe(constraint.via)} — ` +
      `the documentation says access should go through it.`,
    ),
  ];
}

/**
 * `must-not-cycle(A)`: any dependency cycle touching A.
 *
 * Runs at module level, which is the level the constraint is written at. A file
 * cycle inside one module is invisible to a module-level walk, and that is the
 * right call: a sentence saying "the domain must not cycle" is about the domain
 * as a unit, not about two files in it importing each other.
 *
 * Tarjan's strongly connected components rather than a path search. Every cycle
 * lies inside exactly one SCC, so one linear pass finds them all, and the
 * component is reported rather than a single arbitrary loop through it — a
 * three-module tangle is one finding, not the six loops you could trace in it.
 */
function detectCycles(constraint: Constraint, index: Index): Violation[] {
  const target = constraint.subject.status === 'MODULE' ? constraint.subject.target : null;
  const components = stronglyConnectedComponents(index.outbound);

  const touching = components.filter((component) => {
    if (component.length < 2) return false;
    if (target !== null) return component.includes(target);
    // A path-pattern subject: any module holding one of its files counts.
    const files = filesFor(constraint.subject, index);
    return component.some((moduleId) =>
      [...(index.filesByModule.get(moduleId) ?? [])].some((file) => files.has(file)),
    );
  });

  return touching.map((component) => {
    const members = new Set(component);
    const edges = index.fileEdges
      .filter((edge) => {
        const from = index.moduleByFile.get(edge.from);
        const to = index.moduleByFile.get(edge.to);
        return from !== undefined && to !== undefined && from !== to && members.has(from) && members.has(to);
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    return build(constraint, 'cycle', edges, index, component, (count) =>
      `${describe(constraint.subject)} is part of a dependency cycle spanning ` +
      `${component.length} modules (${component.join(' -> ')} -> ${component[0] as string}), ` +
      `held together by ${count} import statement(s). The documentation says it must not cycle.`,
    );
  });
}

/**
 * Tarjan's algorithm, iterative.
 *
 * Iterative rather than recursive because a 1,900-file repository produces
 * chains deep enough to blow the call stack, and a conformance check that
 * crashes on large inputs is worse than one that reports nothing.
 *
 * Node order and successor order are sorted, so the components — and therefore
 * the violation ids built from them — are identical across runs.
 */
export function stronglyConnectedComponents(
  outbound: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  const nodes = [...new Set([...outbound.keys(), ...[...outbound.values()].flatMap((set) => [...set])])].sort();

  const indexOf = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of nodes) {
    if (indexOf.has(root)) continue;

    // Each frame keeps its own successor cursor, replacing the recursive call.
    const work: { node: string; successors: string[]; cursor: number }[] = [
      { node: root, successors: [...(outbound.get(root) ?? [])].sort(), cursor: 0 },
    ];
    indexOf.set(root, counter);
    lowLink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: string; successors: string[]; cursor: number };

      if (frame.cursor < frame.successors.length) {
        const next = frame.successors[frame.cursor] as string;
        frame.cursor += 1;

        if (!indexOf.has(next)) {
          indexOf.set(next, counter);
          lowLink.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, successors: [...(outbound.get(next) ?? [])].sort(), cursor: 0 });
        } else if (onStack.has(next)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node) ?? 0, indexOf.get(next) ?? 0));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node) ?? 0, lowLink.get(frame.node) ?? 0));
      }

      if (lowLink.get(frame.node) === indexOf.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        // Sorted so a component is written the same way every run.
        components.push(component.sort());
      }
    }
  }

  return components.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
}

// ---------------------------------------------------------------- assembly

function build(
  constraint: Constraint,
  kind: ViolationKind,
  edges: readonly FileEdge[],
  index: Index,
  cycle: readonly string[],
  explain: (importCount: number, fileCount: number) => string,
): Violation {
  const violating: ViolatingEdge[] = edges.map((edge) => ({
    edgeId: edge.id,
    fromModule: index.moduleByFile.get(edge.from) ?? '(unknown)',
    toModule: index.moduleByFile.get(edge.to) ?? '(unknown)',
    fromFile: edge.from,
    toFile: edge.to,
    importCount: edge.importCount,
    evidence: edge.evidence,
  }));

  const importCount = violating.reduce((total, edge) => total + edge.importCount, 0);
  const severity = scoreSeverity({
    constraintConfidence: constraint.confidence,
    localResolutionRate: localResolution(edges, index),
    importCount,
    allEdgesDerived: edges.every((edge) => edge.provenance === 'DERIVED'),
  });

  return {
    id: violationId(constraint.id, kind, violating.map((edge) => edge.edgeId)),
    constraintId: constraint.id,
    kind,
    severity: severity.severity,
    severityScore: severity.score,
    severityFactors: severity.factors,
    edges: violating,
    cycle,
    explanation: explain(importCount, violating.length),
    constraint,
  };
}

/**
 * Resolution rate of just the files implicated in this violation.
 *
 * Deliberately local. A repository-wide rate would discount a violation found
 * in a cleanly resolved corner because some unrelated package uses dynamic
 * imports everywhere, and that is not information about this finding.
 */
function localResolution(edges: readonly FileEdge[], index: Index): number {
  const files = new Set(edges.flatMap((edge) => [edge.from, edge.to]));

  let resolved = 0;
  let total = 0;
  for (const file of files) {
    const imports = index.importsByFile.get(file) ?? 0;
    const unresolved = index.unresolvedByFile.get(file) ?? 0;
    resolved += imports;
    total += imports + unresolved;
  }

  // A file with no imports at all is not evidence of poor resolution.
  return total === 0 ? 1 : resolved / total;
}

function violationId(constraintId: string, kind: ViolationKind, edgeIds: readonly string[]): string {
  return createHash('sha256')
    .update([constraintId, kind, [...edgeIds].sort().join(',')].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
}

/** The words the document used, not a module id — the user has to recognise it. */
function describe(subject: ResolvedSubject | null): string {
  if (subject === null) return 'the routing module';
  return subject.phrase;
}

function summarise(
  constraints: readonly Constraint[],
  violations: readonly Violation[],
  unchecked: readonly UncheckedConstraint[],
): ViolationSummary {
  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  const byKind: Record<ViolationKind, number> = {
    'forbidden-import': 0,
    'bypassed-route': 0,
    cycle: 0,
    'upward-dependency': 0,
  };
  const byUncheckedReason: Record<UncheckedReason, number> = {
    'unresolved-role': 0,
    'empty-target': 0,
  };

  const implicated = new Set<string>();
  for (const violation of violations) {
    bySeverity[violation.severity] += 1;
    byKind[violation.kind] += 1;
    for (const edge of violation.edges) implicated.add(edge.edgeId);
  }
  for (const entry of unchecked) byUncheckedReason[entry.reason] += 1;

  const violated = new Set(violations.map((violation) => violation.constraintId)).size;
  const checked = constraints.length - unchecked.length;

  return {
    constraints: constraints.length,
    checked,
    unchecked: unchecked.length,
    violated,
    // Counted explicitly: a rule that was checked and held is a result, and
    // reporting only failures would make a clean repository look unexamined.
    satisfied: checked - violated,
    violations: violations.length,
    bySeverity,
    byKind,
    byUncheckedReason,
    implicatedEdges: implicated.size,
  };
}
