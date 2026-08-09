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
    const pattern = normalisePattern(lower);
    const directories = options.directories ?? collectDirectories(options.candidates);
    if (matchesAnyDirectory(pattern, directories)) {
      return { phrase: trimmed, status: 'PATH_PATTERN', target: pattern, reason: null, similarity: 1, alternatives: [] };
    }
    return unresolved('no-candidate');
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

function matchesAnyDirectory(pattern: string, directories: readonly string[]): boolean {
  const prefix = pattern.replace(/\/?\*\*?$/, '').replace(/\*/g, '');
  if (prefix === '') return false;
  return directories.some((directory) => directory === prefix || directory.startsWith(`${prefix}/`));
}

export function summariseSubjects(subjects: readonly ResolvedSubject[]): SubjectResolutionSummary {
  const byReason: Record<SubjectUnresolvedReason, number> = {
    'no-candidate': 0,
    ambiguous: 0,
    'low-similarity': 0,
    'no-such-layer': 0,
    'external-subject': 0,
  };

  let module = 0;
  let pathPattern = 0;
  let unresolved = 0;

  for (const subject of subjects) {
    if (subject.status === 'MODULE') module += 1;
    else if (subject.status === 'PATH_PATTERN') pathPattern += 1;
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
    unresolved,
    resolutionRate: total === 0 ? 100 : ((total - unresolved) / total) * 100,
    byReason,
  };
}
