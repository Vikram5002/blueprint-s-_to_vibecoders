import { describe, expect, it } from 'vitest';
import { resolveSubject, summariseSubjects, type ResolutionCandidate,
  resolveRegexSubject,
} from './resolve-subject.js';

const candidates: ResolutionCandidate[] = [
  { moduleId: 'm-parser', label: 'Source Parsing', directories: ['src/parser'], fileCount: 12 },
  { moduleId: 'm-graph', label: 'Dependency Graph', directories: ['src/graph'], fileCount: 9 },
  { moduleId: 'm-server', label: 'HTTP Server', directories: ['src/server'], fileCount: 5 },
  { moduleId: 'm-ui', label: 'React Interface', directories: ['ui/src', 'ui/src/panels'], fileCount: 20 },
];

const resolve = (phrase: string): ReturnType<typeof resolveSubject> => resolveSubject(phrase, { candidates });

describe('resolving a phrase to a module', () => {
  it('matches a directory basename named directly in the prose', () => {
    const result = resolve('the parser');
    expect(result.status).toBe('MODULE');
    expect(result.target).toBe('m-parser');
  });

  it('ignores articles and the word "layer" so phrasing does not decide the match', () => {
    expect(resolve('the parser layer').target).toBe(resolve('parser').target);
  });

  it('matches a module by its label rather than its path', () => {
    const result = resolve('the dependency graph');
    expect(result.status).toBe('MODULE');
    expect(result.target).toBe('m-graph');
  });

  it('handles camelCase in a label', () => {
    const camel: ResolutionCandidate[] = [
      { moduleId: 'm-x', label: 'orderProcessing', directories: ['src/x'], fileCount: 2 },
    ];
    expect(resolveSubject('order processing', { candidates: camel }).status).toBe('MODULE');
  });

  it('treats a plural in the prose as the singular in the code', () => {
    const plural: ResolutionCandidate[] = [
      { moduleId: 'm-c', label: 'Controller', directories: ['app/controller'], fileCount: 3 },
    ];
    expect(resolveSubject('the controllers', { candidates: plural }).target).toBe('m-c');
  });
});

describe('refusing rather than guessing', () => {
  it('reports an unknown phrase as no-candidate', () => {
    const result = resolve('the billing engine');
    expect(result.status).toBe('UNRESOLVED');
    expect(result.reason).toBe('no-candidate');
  });

  it('distinguishes a layer this repository does not have', () => {
    const result = resolve('the persistence layer');
    expect(result.status).toBe('UNRESOLVED');
    // Not "no-candidate": the phrase is a real layer name, so the useful reading
    // is that the intended structure was never built.
    expect(result.reason).toBe('no-such-layer');
  });

  it('refuses a near-tie instead of flipping a coin', () => {
    const twins: ResolutionCandidate[] = [
      { moduleId: 'm-a', label: 'Core Utilities', directories: ['src/core'], fileCount: 4 },
      { moduleId: 'm-b', label: 'Core Utilities', directories: ['lib/core'], fileCount: 4 },
    ];
    const result = resolveSubject('core utilities', { candidates: twins });
    expect(result.status).toBe('UNRESOLVED');
    expect(result.reason).toBe('ambiguous');
  });

  it('shows its working when it refuses an ambiguous phrase', () => {
    const twins: ResolutionCandidate[] = [
      { moduleId: 'm-a', label: 'Core Utilities', directories: ['src/core'], fileCount: 4 },
      { moduleId: 'm-b', label: 'Core Utilities', directories: ['lib/core'], fileCount: 4 },
    ];
    expect(resolveSubject('core utilities', { candidates: twins }).alternatives).toContain('m-b');
  });

  it('recognises a subject that lives outside the repository', () => {
    const result = resolve('the third-party payments API');
    expect(result.reason).toBe('external-subject');
  });

  it('reports the similarity it found, so the threshold is inspectable', () => {
    const result = resolve('the billing engine');
    expect(result.similarity).toBeGreaterThanOrEqual(0);
    expect(result.similarity).toBeLessThan(1);
  });

  it('never returns a target when it is UNRESOLVED', () => {
    for (const phrase of ['the billing engine', 'the persistence layer', 'the third-party payments API']) {
      expect(resolve(phrase).target).toBeNull();
    }
  });
});

describe('path patterns', () => {
  it('accepts a glob that corresponds to a real directory', () => {
    const result = resolveSubject('src/parser/**', { candidates, directories: ['src/parser', 'src/graph'] });
    expect(result.status).toBe('PATH_PATTERN');
    expect(result.target).toBe('src/parser/**');
  });

  it('completes a bare directory path into a glob', () => {
    const result = resolveSubject('src/graph', { candidates, directories: ['src/graph'] });
    expect(result.status).toBe('PATH_PATTERN');
    expect(result.target).toBe('src/graph/**');
  });

  it('resolves the shorthand documents actually use', () => {
    // CLAUDE.md writes `parser/` for a directory that lives at src/parser.
    const result = resolveSubject('parser/', { candidates, directories: ['src/parser', 'src/graph'] });
    expect(result.status).toBe('PATH_PATTERN');
    expect(result.target).toBe('src/parser/**');
  });

  it('refuses a shorthand that matches two directories', () => {
    const result = resolveSubject('parser/', {
      candidates,
      directories: ['src/parser', 'vendor/parser'],
    });
    expect(result.status).toBe('UNRESOLVED');
    expect(result.reason).toBe('ambiguous');
    expect(result.alternatives).toEqual(['src/parser', 'vendor/parser']);
  });

  it('prefers a root match over a deeper one with the same name', () => {
    const result = resolveSubject('parser/', { candidates, directories: ['parser', 'src/parser'] });
    expect(result.target).toBe('parser/**');
  });

  it('rejects a path that no longer exists rather than constraining nothing', () => {
    const result = resolveSubject('src/legacy/**', { candidates, directories: ['src/parser'] });
    expect(result.status).toBe('UNRESOLVED');
    expect(result.reason).toBe('no-candidate');
  });
});

describe('determinism', () => {
  it('does not depend on the order candidates are supplied in', () => {
    const forward = resolveSubject('the parser', { candidates });
    const backward = resolveSubject('the parser', { candidates: [...candidates].reverse() });
    expect(forward).toEqual(backward);
  });

  it('breaks an exact tie on module id', () => {
    const identical: ResolutionCandidate[] = [
      { moduleId: 'm-zeta', label: 'Widgets', directories: ['src/widgets'], fileCount: 1 },
      { moduleId: 'm-alpha', label: 'Widgets', directories: ['src/widgets'], fileCount: 1 },
    ];
    const result = resolveSubject('widgets', { candidates: identical });
    // Tied and therefore ambiguous, but the ordering underneath is stable.
    expect(result.alternatives[0]).toBe('m-zeta');
  });
});

describe('summary', () => {
  it('reports resolution rate and the reasons behind every failure', () => {
    const summary = summariseSubjects([
      resolve('the parser'),
      resolve('the dependency graph'),
      resolve('the billing engine'),
      resolve('the persistence layer'),
    ]);

    expect(summary.total).toBe(4);
    expect(summary.module).toBe(2);
    expect(summary.unresolved).toBe(2);
    expect(summary.resolutionRate).toBe(50);
    expect(summary.byReason['no-candidate']).toBe(1);
    expect(summary.byReason['no-such-layer']).toBe(1);
  });

  it('reports 100% when there is nothing to resolve', () => {
    expect(summariseSubjects([]).resolutionRate).toBe(100);
  });
});

describe('regex subjects bind to real files, not to a prefix', () => {
  /**
   * Corpus B is why this exists. Machine-checkable configs address modules by
   * regular expression, and the first attempt reduced each pattern to a path
   * prefix before resolving. That bound 2 of 1,300 constraints — a config
   * regex is seldom a prefix, and `^(packages/[^/]+)/src/` has no usable one
   * at all.
   */
  const FILES = [
    'packages/client/src/index.ts',
    'packages/client/src/query.ts',
    'packages/engine/src/run.ts',
    'src/cli/main.ts',
    'src/cli/args.ts',
    'src/report/html.ts',
  ];
  const moduleByFile = new Map<string, string>([
    ['packages/client/src/index.ts', 'm-client'],
    ['packages/client/src/query.ts', 'm-client'],
    ['packages/engine/src/run.ts', 'm-engine'],
    ['src/cli/main.ts', 'm-cli'],
    ['src/cli/args.ts', 'm-cli'],
    ['src/report/html.ts', 'm-report'],
  ]);
  const opts = { files: FILES, moduleByFile };

  it('binds a dependency-cruiser style anchored pattern', () => {
    const r = resolveRegexSubject('(^src/cli/)', opts);
    expect(r.status).toBe('REGEX_PATTERN');
    expect(r.target).toBe('(^src/cli/)');
    expect(r.alternatives).toEqual(['m-cli']);
    expect(r.origin).toBe('regex');
  });

  it('binds a pattern with a character class that no prefix could express', () => {
    const r = resolveRegexSubject('^packages/[^/]+/src/', opts);
    expect(r.status).toBe('REGEX_PATTERN');
    // Both packages, which is exactly what the pattern says.
    expect(r.alternatives).toEqual(['m-client', 'm-engine']);
  });

  it('reports UNRESOLVED — never an empty set — when nothing matches', () => {
    /**
     * The unmeasured-zero family (Finding 2) at its most dangerous. An empty
     * subject makes its constraint vacuously true, because no edge can leave
     * nothing — so a rule that failed to bind would be reported as a rule that
     * held, and the conformance report would claim compliance it never
     * measured.
     */
    const r = resolveRegexSubject('^does-not-exist/', opts);
    expect(r.status).toBe('UNRESOLVED');
    expect(r.reason).toBe('pattern-matched-nothing');
    expect(r.target).toBeNull();
  });

  it('refuses a capture-group backreference rather than binding it literally', () => {
    // `$1` means "each package independently" — N rules wearing one rule's
    // clothes. A single constraint cannot say that, and binding `$1` as a
    // literal path would quietly produce a rule about a path that does not
    // exist.
    const r = resolveRegexSubject('$1', opts);
    expect(r.status).toBe('UNRESOLVED');
    expect(r.reason).toBe('capture-group-backreference');
  });

  it('refuses a pattern the engine will not compile', () => {
    const r = resolveRegexSubject('^packages/([a-z', opts);
    expect(r.status).toBe('UNRESOLVED');
    expect(r.reason).toBe('pattern-invalid');
  });

  it('is deterministic across runs and independent of file order', () => {
    const forward = resolveRegexSubject('^packages/', opts);
    const reversed = resolveRegexSubject('^packages/', {
      files: [...FILES].reverse(),
      moduleByFile,
    });
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });
});

describe('resolution is reported separately by origin', () => {
  // A prose phrase and a config regex fail for unrelated reasons — one is a
  // naming problem, the other a pattern-matching one — so a single blended
  // rate hides both.
  function subject(status: 'MODULE' | 'REGEX_PATTERN' | 'UNRESOLVED', origin?: 'prose' | 'regex') {
    return {
      phrase: 'x',
      status,
      target: status === 'UNRESOLVED' ? null : 'x',
      reason: status === 'UNRESOLVED' ? ('no-candidate' as const) : null,
      similarity: 1,
      alternatives: [],
      ...(origin === undefined ? {} : { origin }),
    };
  }

  it('counts prose and regex roles in their own buckets', () => {
    const summary = summariseSubjects([
      subject('MODULE', 'prose'),
      subject('UNRESOLVED', 'prose'),
      subject('REGEX_PATTERN', 'regex'),
      subject('REGEX_PATTERN', 'regex'),
      subject('UNRESOLVED', 'regex'),
    ]);

    expect(summary.byOrigin.prose).toEqual({ total: 2, resolved: 1 });
    expect(summary.byOrigin.regex).toEqual({ total: 3, resolved: 2 });
    expect(summary.regexPattern).toBe(2);
  });

  it('treats a role with no origin as prose, which is where they all came from before', () => {
    const summary = summariseSubjects([subject('MODULE')]);
    expect(summary.byOrigin.prose.total).toBe(1);
    expect(summary.byOrigin.regex.total).toBe(0);
  });
});
