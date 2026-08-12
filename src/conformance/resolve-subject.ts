/**
 * Mapping a prose noun phrase onto something the graph can name.
 *
 * This is the hard part of the week and the one with the worst failure mode.
 * Prose says "the domain layer"; the graph has `module-014` labelled
 * `packages/zod/src/`. Getting the mapping wrong does not produce a missing
 * result — it produces a *confident wrong* one, a constraint aimed at an
 * innocent module that will generate false violations in Week 8. The project's
 * own proposal says a false violation costs more trust than a missed one, so
 * this module is built to refuse rather than to guess.
 *
 * Deterministic and offline. It does not import from `llm/` and must not: this
 * is exactly the case CLAUDE.md means by "do not let the LLM infer structure
 * when static analysis can determine it". The model's job is to read the
 * sentence; deciding which module a name refers to is a matching problem over
 * data we already hold, and doing it here keeps it reproducible and inspectable.
 */
import type {
  ResolvedSubject,
  SubjectResolutionSummary,
  SubjectUnresolvedReason,
} from '../types/constraints.js';

export interface ResolutionCandidate {
  readonly moduleId: string;
  /** Best current name: user correction, else model label, else mechanical. */
  readonly label: string;
  readonly directories: readonly string[];
  readonly fileCount: number;
}

export interface ResolveOptions {
  readonly candidates: readonly ResolutionCandidate[];
  /** Every directory in the repository, for path-pattern matching. */
  readonly directories?: readonly string[];
}

/**
 * Accept a single best match at or above this.
 *
 * Set high on purpose. Below roughly two-thirds token agreement, a phrase and a
 * module name are usually about different things that happen to share a common
 * word like "service" or "core".
 */
export const ACCEPT_SIMILARITY = 0.62;

/**
 * Below this, nothing plausible was found at all — reported as `no-candidate`
 * rather than `low-similarity`, because the distinction tells the user whether
 * to rename a module or rewrite a sentence.
 */
export const FLOOR_SIMILARITY = 0.25;

/**
 * If the runner-up is within this of the winner, refuse.
 *
 * A near-tie means the phrase genuinely does not pick one module out. Choosing
 * the winner anyway would be a coin flip presented as a finding, and the user
 * has no way to tell it apart from a real match.
 */
export const AMBIGUITY_MARGIN = 0.08;

/**
 * Words that carry no discriminating power in an architecture description.
 *
 * "The domain layer" and "domain" must score the same, or the phrasing of the
 * sentence decides the match instead of its content.
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'our', 'its', 'this', 'that', 'these', 'those', 'all', 'any',
  'layer', 'layers', 'module', 'modules', 'package', 'packages', 'component',
  'components', 'code', 'codebase', 'directory', 'directories', 'folder',
  'folders', 'file', 'files', 'part', 'parts', 'side', 'tier', 'level',
  'logic', 'stuff', 'things', 'system',
]);

/**
 * Phrases that name something outside the repository.
 *
 * A constraint about a third-party service is not checkable against an import
 * graph and should not be matched to whichever local module sounds closest.
 */
const EXTERNAL_MARKERS = [
  'third-party', 'third party', 'external service', 'upstream service',
  'vendor', 'saas', 'their api', 'the internet', 'external api',
];

/**
 * Layer names common in architecture writing. Used only to distinguish "this
 * repository has no such layer" from "no candidate at all" — a more useful
 * message, and one that tells the user the sentence may describe an intended
 * structure that was never built.
 */
const KNOWN_LAYER_WORDS = new Set([
  'domain', 'application', 'infrastructure', 'presentation', 'persistence',
  'controller', 'controllers', 'service', 'services', 'repository',
  'repositories', 'entity', 'entities', 'adapter', 'adapters', 'port', 'ports',
  'usecase', 'usecases', 'handler', 'handlers', 'view', 'views', 'model',
  'models', 'api', 'ui', 'db', 'database', 'core', 'shared', 'common', 'util',
  'utils', 'helper', 'helpers',
]);

export function resolveSubject(phrase: string, options: ResolveOptions): ResolvedSubject {
  const trimmed = phrase.trim();
  const lower = trimmed.toLowerCase();

  const unresolved = (reason: SubjectUnresolvedReason, similarity = 0, alternatives: string[] = []): ResolvedSubject => ({
    phrase: trimmed,
    status: 'UNRESOLVED',
    target: null,
    reason,
    similarity,
    alternatives,
  });

  if (trimmed === '') return unresolved('no-candidate');

  if (EXTERNAL_MARKERS.some((marker) => lower.includes(marker))) {
    return unresolved('external-subject');
  }

  // A phrase that is already a path or a glob is not a naming problem. Only
  // accept it if it corresponds to something real, so a stale path in an old
  // README is reported rather than silently becoming a constraint about nothing.
  if (looksLikePath(lower)) {
    const directories = options.directories ?? collectDirectories(options.candidates);
    const resolvedPath = resolvePathPattern(normalisePattern(lower), directories);
    if (resolvedPath.status === 'ok') {
      return {
        phrase: trimmed,
        status: 'PATH_PATTERN',
        target: resolvedPath.pattern,
        reason: null,
        similarity: 1,
        alternatives: [],
      };
    }
    return unresolved(resolvedPath.reason, 0, resolvedPath.alternatives);
  }

  const wanted = tokenise(trimmed);
  if (wanted.size === 0) return unresolved('no-candidate');

  const scored = options.candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(wanted, candidate) }))
    // Ties break on module id so the result never depends on input order.
    .sort((a, b) => b.score - a.score || a.candidate.moduleId.localeCompare(b.candidate.moduleId));

  const best = scored[0];
  if (best === undefined || best.score < FLOOR_SIMILARITY) {
    const layerish = [...wanted].some((token) => KNOWN_LAYER_WORDS.has(token));
    return unresolved(layerish ? 'no-such-layer' : 'no-candidate', best?.score ?? 0);
  }

  const alternatives = scored.slice(1, 4).map((entry) => entry.candidate.moduleId);

  const runnerUp = scored[1];
  if (runnerUp !== undefined && best.score - runnerUp.score < AMBIGUITY_MARGIN && runnerUp.score >= FLOOR_SIMILARITY) {
    return unresolved('ambiguous', best.score, alternatives);
  }

  if (best.score < ACCEPT_SIMILARITY) {
    return unresolved('low-similarity', best.score, alternatives);
  }

  return {
    phrase: trimmed,
    status: 'MODULE',
    target: best.candidate.moduleId,
    reason: null,
    similarity: best.score,
    alternatives,
  };
}

/**
 * Dice coefficient over content tokens, plus a small bonus when the phrase
 * matches a directory basename exactly.
 *
 * Dice rather than Jaccard here because the two sides are asymmetric: a
 * two-word phrase is being compared against a module whose name may carry
 * several path segments, and Jaccard punishes that size difference for no good
 * reason. The exact-basename bonus encodes the observation that "the parser"
 * matching a module rooted at `src/parser/` is a stronger signal than generic
 * token overlap suggests.
 */
function scoreCandidate(wanted: ReadonlySet<string>, candidate: ResolutionCandidate): number {
  // Spread each tokenise() result explicitly: flatMap flattens arrays, not Sets,
  // so mapping straight to a Set inserts the Set object as a member and every
  // directory token silently disappears.
  const available = new Set<string>(tokenise(candidate.label));
  for (const directory of candidate.directories) {
    for (const token of tokenise(directory.split('/').join(' '))) available.add(token);
  }
  if (available.size === 0) return 0;

  let shared = 0;
  for (const token of wanted) {
    if (available.has(token)) shared += 1;
  }
  const dice = (2 * shared) / (wanted.size + available.size);

  const basenames = new Set(
    candidate.directories.map((directory) => directory.split('/').filter(Boolean).at(-1)?.toLowerCase() ?? ''),
  );
  const exactBasename = [...wanted].some((token) => basenames.has(token));

  return Math.min(1, exactBasename ? dice + 0.35 : dice);
}

function tokenise(text: string): Set<string> {
  const tokens = text
    // Split camelCase and PascalCase before lowercasing — after it, there is no
    // case left to split on and the branch can never fire.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));

  // Crude depluralisation, so "controllers" and "controller" agree.
  return new Set(tokens.map((token) => (token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token)));
}

function looksLikePath(text: string): boolean {
  return /[/*]/.test(text) && !/\s/.test(text.trim());
}

function normalisePattern(text: string): string {
  const cleaned = text.replace(/^\.\//, '').replace(/^`|`$/g, '').replace(/\/+$/, '');
  return cleaned.includes('*') ? cleaned : `${cleaned}/**`;
}

function collectDirectories(candidates: readonly ResolutionCandidate[]): string[] {
  return [...new Set(candidates.flatMap((candidate) => candidate.directories))];
}

type PathResolution =
  | { readonly status: 'ok'; readonly pattern: string }
  | { readonly status: 'fail'; readonly reason: SubjectUnresolvedReason; readonly alternatives: string[] };

/**
 * Matches a written path against the repository's real directories.
 *
 * Tried from the repository root first, then as a trailing segment. The second
 * pass exists because documents overwhelmingly write shorthand: this project's
 * own CLAUDE.md says `parser/` and `llm/` for directories that live at
 * `src/parser` and `src/llm`. Rejecting those is not strictness, it is failing
 * to read the document the way its author wrote it.
 *
 * Found by the oracle test in evaluate.test.ts, which put the hand-labelled
 * constraints through the resolver and scored 44%: every root-relative
 * shorthand in the gold set was being dropped, and only the two paths that
 * happened to sit at the repository root resolved at all.
 *
 * A shorthand matching two directories is ambiguous and refused, for the same
 * reason a tied module match is refused — `parser/` where both `src/parser` and
 * `vendor/parser` exist genuinely does not pick one out.
 */
function resolvePathPattern(pattern: string, directories: readonly string[]): PathResolution {
  const prefix = pattern.replace(/\/?\*\*?$/, '').replace(/\*/g, '');
  if (prefix === '') return { status: 'fail', reason: 'no-candidate', alternatives: [] };

  const fromRoot = directories.some((directory) => directory === prefix || directory.startsWith(`${prefix}/`));
  if (fromRoot) return { status: 'ok', pattern };

  const suffixMatches = [
    ...new Set(
      directories
        .filter((directory) => directory === prefix || directory.endsWith(`/${prefix}`))
        .map((directory) => directory),
    ),
  ].sort();

  if (suffixMatches.length === 1) {
    return { status: 'ok', pattern: `${suffixMatches[0] as string}/**` };
  }
  if (suffixMatches.length > 1) {
    return { status: 'fail', reason: 'ambiguous', alternatives: suffixMatches.slice(0, 4) };
  }
  return { status: 'fail', reason: 'no-candidate', alternatives: [] };
}

export function summariseSubjects(subjects: readonly ResolvedSubject[]): SubjectResolutionSummary {
  const byReason: Record<SubjectUnresolvedReason, number> = {
    'no-candidate': 0,
    ambiguous: 0,
    'low-similarity': 0,
    'no-such-layer': 0,
    'external-subject': 0,
    'pattern-matched-nothing': 0,
    'pattern-invalid': 0,
    'capture-group-backreference': 0,
  };

  let module = 0;
  let pathPattern = 0;
  let regexPattern = 0;
  let unresolved = 0;
  /**
   * Split by origin, because a prose phrase and a config regex fail for
   * unrelated reasons — one is a naming problem, the other a pattern-matching
   * one — and a single blended rate hides both.
   */
  const byOrigin = {
    prose: { total: 0, resolved: 0 },
    regex: { total: 0, resolved: 0 },
  };

  for (const subject of subjects) {
    const resolved = subject.status !== 'UNRESOLVED';
    const bucket = subject.origin === 'regex' ? byOrigin.regex : byOrigin.prose;
    bucket.total += 1;
    if (resolved) bucket.resolved += 1;

    if (subject.status === 'MODULE') module += 1;
    else if (subject.status === 'PATH_PATTERN') pathPattern += 1;
    else if (subject.status === 'REGEX_PATTERN') regexPattern += 1;
    else {
      unresolved += 1;
      if (subject.reason !== null) byReason[subject.reason] += 1;
    }
  }

  const total = subjects.length;
  return {
    total,
    module,
    pathPattern,
    regexPattern,
    unresolved,
    byOrigin,
    resolutionRate: total === 0 ? 100 : ((total - unresolved) / total) * 100,
    byReason,
  };
}

// ---------------------------------------------------------------- regex mode

/**
 * `$1`-style backreference, as dependency-cruiser uses it.
 *
 * A rule like `from: '^(packages/[^/]+)/src/'`, `to: { pathNot: '$1' }` means
 * "each package may import only itself" — one rule standing for N independent
 * rules, one per package. A single Constraint cannot say that: its subject and
 * object are fixed sets, and binding `$1` as a literal would silently produce
 * a rule about a path that does not exist.
 *
 * So these are refused. Expanding them into one constraint per capture value
 * is the correct semantics and is deliberately left undone rather than
 * approximated — see docs/VIOLATIONS.md.
 */
const BACKREFERENCE = /\$\d/;

export interface RegexResolveOptions {
  /** Every file path in the derived graph, repo-relative, posix separators. */
  readonly files: readonly string[];
  /** File path -> module id, so matched files can be reported as modules. */
  readonly moduleByFile: ReadonlyMap<string, string>;
}

/**
 * Binds a config regular expression to the modules it actually covers.
 *
 * Matched against real file paths rather than reduced to a prefix first.
 * Corpus B established why: prefix reduction bound 2 of 1,300 constraints,
 * because a config regex is seldom a prefix — `^(packages/[^/]+)/src/` has no
 * usable prefix at all.
 *
 * Deterministic by construction: the pattern is applied to a sorted file list
 * and the resulting module ids are sorted, so the same graph and pattern give
 * the same set on every run.
 */
export function resolveRegexSubject(
  pattern: string,
  options: RegexResolveOptions,
): ResolvedSubject {
  const base: Omit<ResolvedSubject, 'status' | 'target' | 'reason' | 'similarity' | 'alternatives'> = {
    phrase: pattern,
    origin: 'regex',
  };

  if (BACKREFERENCE.test(pattern)) {
    return {
      ...base,
      status: 'UNRESOLVED',
      target: null,
      reason: 'capture-group-backreference',
      similarity: 0,
      alternatives: [],
    };
  }

  let expression: RegExp;
  try {
    expression = new RegExp(pattern);
  } catch {
    return {
      ...base,
      status: 'UNRESOLVED',
      target: null,
      reason: 'pattern-invalid',
      similarity: 0,
      alternatives: [],
    };
  }

  const matchedModules = new Set<string>();
  let matchedFiles = 0;
  for (const file of options.files) {
    if (!expression.test(file)) continue;
    matchedFiles += 1;
    const moduleId = options.moduleByFile.get(file);
    if (moduleId !== undefined) matchedModules.add(moduleId);
  }

  /**
   * Zero matches is UNRESOLVED, never an empty set.
   *
   * An empty subject makes its constraint vacuously true — no edge can cross
   * out of nothing — so a rule that failed to bind would be reported as a rule
   * that held. That is the unmeasured-zero family (Finding 2) in the place it
   * would do most damage: a conformance report claiming compliance it never
   * measured.
   */
  if (matchedFiles === 0) {
    return {
      ...base,
      status: 'UNRESOLVED',
      target: null,
      reason: 'pattern-matched-nothing',
      similarity: 0,
      alternatives: [],
    };
  }

  return {
    ...base,
    status: 'REGEX_PATTERN',
    // The pattern itself is the target: it is what `filesFor` re-applies.
    target: pattern,
    reason: null,
    similarity: 1,
    alternatives: [...matchedModules].sort().slice(0, 4),
  };
}
