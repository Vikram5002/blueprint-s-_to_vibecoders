import { describe, expect, it } from 'vitest';
import {
  analyzePrompt,
  createProjectSchemaGenerator,
  PROJECT_SCHEMA_JSON_SCHEMA,
  PROJECT_SCHEMA_SYSTEM_PROMPT,
} from './generate-project-schema.js';
import { componentId } from '../types/project-schema.js';
import type { CompletionProvider, CompletionRequest, CompletionResult } from '../llm/provider.js';
import type { CachedLabel, LabelCache } from '../llm/cache.js';

function memoryCache(): LabelCache & { entries: Map<string, CachedLabel> } {
  const entries = new Map<string, CachedLabel>();
  return {
    entries,
    get: (key) => entries.get(key),
    set: (key, value) => void entries.set(key, value),
    flush: async () => true,
    get size() {
      return entries.size;
    },
  };
}

function stubProvider(
  respond: (request: CompletionRequest) => CompletionResult,
): CompletionProvider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    calls,
    name: 'stub',
    model: 'stub-model',
    complete: async (request) => {
      calls.push(request);
      return respond(request);
    },
  };
}

function okResult(text: string): CompletionResult {
  return {
    ok: true,
    value: { text, model: 'stub-model', usage: { promptTokens: 500, completionTokens: 200, cachedPromptTokens: 0 } },
  };
}

const VALID_SCHEMA_NO_CONSTRAINTS = {
  sessionId: 'session-test-001',
  title: 'Team Task Board',
  originalPrompt: 'irrelevant for this fixture',
  domains: {
    frontend: {
      components: [{ id: 'placeholder-id-does-not-matter', name: 'Board View', purpose: 'Shows columns and cards.' }],
      dependsOn: ['backend'],
    },
    backend: { components: [], dependsOn: [] },
    database: { components: [], dependsOn: [] },
    security: { components: [], dependsOn: [] },
  },
  constraints: [],
  provenance: 'STATED',
};

const VALID_SCHEMA_WITH_CONSTRAINT = {
  sessionId: 'session-test-002',
  title: 'Whistleblower Portal',
  originalPrompt: 'irrelevant for this fixture',
  domains: {
    frontend: { components: [], dependsOn: [] },
    backend: { components: [], dependsOn: [] },
    database: { components: [], dependsOn: [] },
    security: { components: [], dependsOn: [] },
  },
  constraints: [
    {
      id: 'constraint-1',
      relation: 'must-not-import',
      subject: { phrase: "the submitter's identity", status: 'UNRESOLVED', target: null, origin: 'prose', reason: 'no-candidate', similarity: 0, alternatives: [] },
      object: { phrase: 'any log', status: 'UNRESOLVED', target: null, origin: 'prose', reason: 'no-candidate', similarity: 0, alternatives: [] },
      via: null,
      source: { type: 'chat-log', location: 'prompt', line: null, timestamp: null },
      confidence: 0.9,
      lowConfidence: false,
      rawText: 'The system must never log the identity of the submitter.',
      provenance: 'STATED',
    },
  ],
  provenance: 'STATED',
};

describe('analyzePrompt', () => {
  it('flags a well-specified prompt with nothing', () => {
    const prompt =
      "Build a task management app for small teams. Users sign in with email and password. Each team has boards, boards have columns, columns have cards. Team members can drag cards between columns. Only team members can see or edit a team's boards.";
    expect(analyzePrompt(prompt).flags).toEqual([]);
  });

  it('flags an underspecified prompt as vague-scope without flagging it as too-short', () => {
    const prompt = 'Something that helps small groups get organized and communicate better throughout the week.';
    const result = analyzePrompt(prompt);
    expect(result.flags).toEqual(['vague-scope']);
    expect(result.wordCount).toBeGreaterThanOrEqual(6);
  });

  it('flags a very short prompt as both too-short and vague-scope', () => {
    const result = analyzePrompt('Something for tracking stuff.');
    expect(result.flags).toEqual(['too-short', 'vague-scope']);
    expect(result.wordCount).toBeLessThan(6);
  });

  it('flags a contradictory prompt as possible-contradiction, not vague-scope', () => {
    const prompt =
      "A fully offline note app with no server or account, but everyone's data must sync live to a shared cloud dashboard for the whole team.";
    expect(analyzePrompt(prompt).flags).toEqual(['possible-contradiction']);
  });

  it('does not flag an empty prompt as too-short (nothing to be short about)', () => {
    expect(analyzePrompt('').flags).not.toContain('too-short');
  });
});

describe('createProjectSchemaGenerator', () => {
  it('returns a validated ProjectSchema for a well-formed model answer', async () => {
    const provider = stubProvider(() => okResult(JSON.stringify(VALID_SCHEMA_NO_CONSTRAINTS)));
    const generator = createProjectSchemaGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate('Build a task management app for small teams.');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe('Team Task Board');
      expect(result.value.domains.frontend.components).toHaveLength(1);
    }
  });

  it('validates a constraint-bearing answer against the real Constraint shape', async () => {
    const provider = stubProvider(() => okResult(JSON.stringify(VALID_SCHEMA_WITH_CONSTRAINT)));
    const generator = createProjectSchemaGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate('A whistleblower tip portal, fully anonymous.');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.constraints).toHaveLength(1);
      expect(result.value.constraints[0]?.subject.status).toBe('UNRESOLVED');
    }
  });

  it('recomputes component ids via componentId, discarding whatever the model returned', async () => {
    const provider = stubProvider(() => okResult(JSON.stringify(VALID_SCHEMA_NO_CONSTRAINTS)));
    const generator = createProjectSchemaGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate('Build a task management app for small teams.');

    expect(result.ok).toBe(true);
    if (result.ok) {
      const component = result.value.domains.frontend.components[0]!;
      expect(component.id).toBe(componentId('frontend', component.name, component.purpose));
      expect(component.id).not.toBe('placeholder-id-does-not-matter');
    }
  });

  it('recomputes constraint ids, discarding a degenerate repeated-digit id the same way componentId already handles for components', async () => {
    // The real malformed shape a live local-checkpoint generation actually
    // produced on 2026-08-31 (desktop session, schema-injection fix
    // verification) - id: "c966666666666666" is a decoding artifact, not
    // sha256 output, the identical failure mode componentId() was already
    // built to correct on components. No real constraint had ever existed
    // to expose this on a constraint until that session.
    const withDegenerateConstraintId = {
      sessionId: 'session-test-008',
      title: 'Team-Managed Task Boards',
      originalPrompt: 'irrelevant for this fixture',
      domains: {
        frontend: { components: [], dependsOn: [] },
        backend: { components: [], dependsOn: [] },
        database: { components: [], dependsOn: [] },
        security: { components: [], dependsOn: [] },
      },
      constraints: [
        {
          id: 'c966666666666666',
          relation: 'must-not-import',
          subject: { phrase: 'the Teams API' },
          object: { phrase: 'a card or column directly' },
          via: null,
          source: { type: 'chat-log', location: 'session:session-real-023' },
          confidence: 0.9,
          lowConfidence: false,
          rawText: "Only team members can see or edit a team's boards; no card/column access outside the team.",
          provenance: 'STATED',
        },
      ],
      provenance: 'STATED',
    };
    const provider = stubProvider(() => okResult(JSON.stringify(withDegenerateConstraintId)));
    const generator = createProjectSchemaGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate(
      "Build a task management app for small teams. Users sign in with email and password. Each team has boards, boards have columns, columns have cards. Team members can drag cards between columns. Only team members can see or edit a team's boards.",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const id = result.value.constraints[0]!.id;
      // Corrected, not the degenerate artifact.
      expect(id).not.toBe('c966666666666666');
      // A real sha256-slice(16) shape - lowercase hex, exactly 16 characters.
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('recomputed constraint ids are stable across two generations of the same content, mirroring componentId', async () => {
    const withDegenerateConstraintId = {
      sessionId: 'session-test-009',
      title: 'Team-Managed Task Boards',
      originalPrompt: 'irrelevant for this fixture',
      domains: {
        frontend: { components: [], dependsOn: [] },
        backend: { components: [], dependsOn: [] },
        database: { components: [], dependsOn: [] },
        security: { components: [], dependsOn: [] },
      },
      constraints: [
        {
          id: 'c966666666666666',
          relation: 'must-not-import',
          subject: { phrase: 'the Teams API' },
          object: { phrase: 'a card or column directly' },
          via: null,
          source: { type: 'chat-log', location: 'session:session-real-023' },
          confidence: 0.9,
          lowConfidence: false,
          rawText: "Only team members can see or edit a team's boards; no card/column access outside the team.",
          provenance: 'STATED',
        },
      ],
      provenance: 'STATED',
    };
    // Two separate generators, two separate (empty) caches - each call is a
    // genuine independent computation of the id, not a cache replay, the
    // same distinction this session's own real desktop test drew between
    // "the cache guarantees byte-identical output" and "the id scheme
    // itself is content-derived and stable" (source.timestamp was the one
    // field observed to differ between two real independent generations;
    // the id was not).
    const first = await createProjectSchemaGenerator({
      provider: stubProvider(() => okResult(JSON.stringify(withDegenerateConstraintId))),
      cache: memoryCache(),
    }).generate('Build a task management app for small teams.');
    const second = await createProjectSchemaGenerator({
      provider: stubProvider(() => okResult(JSON.stringify(withDegenerateConstraintId))),
      cache: memoryCache(),
    }).generate('Build a task management app for small teams.');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.constraints[0]!.id).toBe(second.value.constraints[0]!.id);
    }
  });

  const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('stamps a fresh randomUUID sessionId on a real generation, discarding a training-id-shaped value from the model', async () => {
    // VALID_SCHEMA_NO_CONSTRAINTS's own sessionId ('session-test-001') is
    // exactly the shape a real generation actually returns - session-gold-021,
    // session-gold-031, session-real-023 - confirmed on 5/5 real local-model
    // calls across two 2026-08-31 desktop sessions, never a fresh id.
    const provider = stubProvider(() => okResult(JSON.stringify(VALID_SCHEMA_NO_CONSTRAINTS)));
    const generator = createProjectSchemaGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate('Build a task management app for small teams.');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sessionId).not.toBe('session-test-001');
      expect(result.value.sessionId).toMatch(UUID_SHAPE);
    }
  });

  it('leaves a cache-hit revalidation sessionId untouched - the same determinism-under-caching property already tested for timestamp', async () => {
    const provider = stubProvider(() => okResult(JSON.stringify(VALID_SCHEMA_NO_CONSTRAINTS)));
    const cache = memoryCache();
    const generator = createProjectSchemaGenerator({ provider, cache });
    const prompt = 'Build a task management app for small teams.';

    const first = await generator.generate(prompt);
    const second = await generator.generate(prompt);

    // Only one real provider call - the second run was served from cache.
    expect(provider.calls).toHaveLength(1);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.sessionId).toMatch(UUID_SHAPE);
      // Not re-stamped on the cache-hit path - same id both times, the same
      // way source.timestamp does not drift to "now" on re-validation.
      expect(second.value.sessionId).toBe(first.value.sessionId);
    }
  });

  it('rejects and does not cache an answer that fails validateProjectSchema', async () => {
    // Not provenance: 'DERIVED' - fillFixedConstraintFields now force-sets
    // provenance to 'STATED' on every candidate before validation runs, so
    // a wrong provenance from the model can no longer reach the validator
    // at all (see the schema-shape test below). title is still genuinely
    // model-controlled and still a valid way to make this fixture invalid.
    const malformed = { ...VALID_SCHEMA_NO_CONSTRAINTS, title: '' };
    const provider = stubProvider(() => okResult(JSON.stringify(malformed)));
    const cache = memoryCache();
    const generator = createProjectSchemaGenerator({ provider, cache });

    const result = await generator.generate('Build a task management app for small teams.');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('schema-violation');
      expect(result.error.rejections.length).toBeGreaterThan(0);
    }
    expect(cache.size).toBe(0);
  });

  it('reports unparseable JSON without throwing', async () => {
    const provider = stubProvider(() => okResult('this is not json'));
    const generator = createProjectSchemaGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate('Anything.');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('unparseable-json');
    }
  });

  it('surfaces a provider failure as provider-error', async () => {
    const provider = stubProvider(() => ({ ok: false, error: { kind: 'unavailable', message: 'network error: refused' } }));
    const generator = createProjectSchemaGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate('Anything.');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('provider-error');
    }
  });

  it('sends the exact training-format system prompt and the caller prompt verbatim as user', async () => {
    const provider = stubProvider((request) => {
      expect(request.system).toBe(PROJECT_SCHEMA_SYSTEM_PROMPT);
      expect(request.user).toBe('Build a task management app for small teams.');
      expect(request.temperature).toBe(0);
      return okResult(JSON.stringify(VALID_SCHEMA_NO_CONSTRAINTS));
    });
    const generator = createProjectSchemaGenerator({ provider, cache: memoryCache() });

    await generator.generate('Build a task management app for small teams.');

    expect(provider.calls).toHaveLength(1);
  });

  it('is deterministic: the same prompt across two calls hits the cache and returns byte-identical output', async () => {
    const provider = stubProvider(() => okResult(JSON.stringify(VALID_SCHEMA_NO_CONSTRAINTS)));
    const cache = memoryCache();
    const generator = createProjectSchemaGenerator({ provider, cache });
    const prompt = 'Build a task management app for small teams.';

    const first = await generator.generate(prompt);
    const second = await generator.generate(prompt);

    // Only one real provider call - the second run was served from cache.
    expect(provider.calls).toHaveLength(1);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
    }
  });

  it('does not cache across different prompts, even against the same provider', async () => {
    let callCount = 0;
    const provider = stubProvider(() => {
      callCount += 1;
      return okResult(JSON.stringify(VALID_SCHEMA_NO_CONSTRAINTS));
    });
    const generator = createProjectSchemaGenerator({ provider, cache: memoryCache() });

    await generator.generate('Build a task management app for small teams.');
    await generator.generate('Build a completely different app.');

    expect(callCount).toBe(2);
  });

  it('the request schema only asks the model for phrase - every other ResolvedSubject field is fixed at generation time', () => {
    const asText = JSON.stringify(PROJECT_SCHEMA_JSON_SCHEMA);
    // All of these are set programmatically now (see fillFixedConstraintFields).
    // status/origin failed 3/3 real Gemini attempts; target/reason failed
    // the next attempt once status/origin stopped being asked for; with
    // those four also gone, via started coming back missing
    // phrase/similarity/alternatives altogether on every constraint-bearing
    // live call tried. similarity/alternatives are always exactly 0/[] at
    // generation time regardless (no code exists yet to compare candidates
    // against), so they joined the programmatic fill too - the request
    // schema now asks ResolvedSubject for nothing but phrase.
    expect(asText).not.toContain('"status"');
    expect(asText).not.toContain('"origin"');
    expect(asText).not.toContain('"target"');
    expect(asText).not.toContain('"reason"');
    expect(asText).not.toContain('"similarity"');
    expect(asText).not.toContain('"alternatives"');
    expect(asText).not.toContain('"line"');
    expect(asText).not.toContain('"timestamp"');
    expect(asText).not.toContain('"provenance"');
    // What still genuinely varies per constraint is still requested.
    expect(asText).toContain('"phrase"');
    expect(asText).toContain('"relation"');
    expect(asText).toContain('"type"');
    expect(asText).toContain('"location"');
  });

  it('fills status/origin/line/timestamp even when the model returns them null (the real Gemini failure mode)', async () => {
    const malformedFromModel = {
      sessionId: 'session-test-003',
      title: 'Recipe Manager',
      originalPrompt: 'irrelevant for this fixture',
      domains: {
        frontend: { components: [], dependsOn: [] },
        backend: { components: [], dependsOn: [] },
        database: { components: [], dependsOn: [] },
        security: { components: [], dependsOn: [] },
      },
      constraints: [
        {
          id: 'constraint-1',
          relation: 'must-not-import',
          // The status: null / origin: null shape three real Gemini calls
          // returned. reason is deliberately kept at a VALID value here
          // ('no-candidate', matching what 2 of those 3 real generations
          // actually produced) rather than the null the very first
          // generation happened to also return for it - reason is
          // explicitly out of scope for this fix (still model-generated),
          // and null is correctly rejected as invalid input regardless of
          // this fix. That one-time reason: null is a separate, weaker-
          // evidence anomaly flagged in the session report, not something
          // this fix addresses.
          subject: { phrase: 'frontend', status: null, target: null, origin: null, reason: 'no-candidate', similarity: 0, alternatives: [] },
          object: { phrase: 'database', status: null, target: null, origin: null, reason: 'no-candidate', similarity: 0, alternatives: [] },
          via: { phrase: 'backend', status: null, target: null, origin: null, reason: 'no-candidate', similarity: 0, alternatives: [] },
          source: { type: 'user-authored', location: 'prompt', line: {}, timestamp: {} },
          confidence: 1,
          lowConfidence: false,
          rawText: 'Frontend must interact with the database only through the backend API.',
          provenance: 'STATED',
        },
      ],
      provenance: 'STATED',
    };
    const provider = stubProvider(() => okResult(JSON.stringify(malformedFromModel)));
    const generator = createProjectSchemaGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate('A recipe manager where users save recipes, tag them, and search by ingredient.');

    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const role of ['subject', 'object'] as const) {
        expect(result.value.constraints[0]![role].status).toBe('UNRESOLVED');
        expect(result.value.constraints[0]![role].origin).toBe('prose');
      }
      const via = result.value.constraints[0]!.via;
      expect(via?.status).toBe('UNRESOLVED');
      expect(via?.origin).toBe('prose');
      expect(result.value.constraints[0]!.source.line).toBeNull();
      expect(typeof result.value.constraints[0]!.source.timestamp).toBe('string');
    }
  });

  it('phrase and alternatives are left as the model produced them - everything else in ResolvedSubject is now overwritten', async () => {
    const provider = stubProvider(() => okResult(JSON.stringify(VALID_SCHEMA_WITH_CONSTRAINT)));
    const generator = createProjectSchemaGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate('A whistleblower tip portal, fully anonymous.');

    expect(result.ok).toBe(true);
    if (result.ok) {
      const subject = result.value.constraints[0]!.subject;
      expect(subject.phrase).toBe("the submitter's identity");
      expect(subject.alternatives).toEqual([]);
    }
  });

  it('fills target/reason with their fixed values even when the model gets them actively wrong, not just null', async () => {
    const withWrongTargetAndReason = {
      sessionId: 'session-test-004',
      title: 'Recipe Manager',
      originalPrompt: 'irrelevant for this fixture',
      domains: {
        frontend: { components: [], dependsOn: [] },
        backend: { components: [], dependsOn: [] },
        database: { components: [], dependsOn: [] },
        security: { components: [], dependsOn: [] },
      },
      constraints: [
        {
          id: 'constraint-1',
          relation: 'must-not-import',
          // Not null this time - a plausible-looking but wrong value, the
          // failure mode the most recent live Gemini call actually hit
          // once status/origin stopped being requested.
          subject: { phrase: 'frontend', status: 'UNRESOLVED', target: 'src/frontend/index.ts', origin: 'prose', reason: 'ambiguous', similarity: 0, alternatives: [] },
          object: { phrase: 'database', status: 'UNRESOLVED', target: 'src/db.ts', origin: 'prose', reason: 'low-similarity', similarity: 0, alternatives: [] },
          via: null,
          source: { type: 'user-authored', location: 'prompt', line: 7, timestamp: '2020-01-01T00:00:00.000Z' },
          confidence: 1,
          lowConfidence: false,
          rawText: 'Frontend must interact with the database only through the backend API.',
          provenance: 'STATED',
        },
      ],
      provenance: 'STATED',
    };
    const provider = stubProvider(() => okResult(JSON.stringify(withWrongTargetAndReason)));
    const generator = createProjectSchemaGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate('A recipe manager.');

    expect(result.ok).toBe(true);
    if (result.ok) {
      const { subject, object } = result.value.constraints[0]!;
      expect(subject.target).toBeNull();
      expect(subject.reason).toBe('no-candidate');
      expect(object.target).toBeNull();
      expect(object.reason).toBe('no-candidate');
      // source.line is also always forced to null, regardless of what a
      // (wrong, since there is no real document) line number the model gave.
      expect(result.value.constraints[0]!.source.line).toBeNull();
    }
  });

  it('fills provenance to STATED on both the constraint and the top-level schema, regardless of what the model returned', async () => {
    const wrongProvenance = {
      ...VALID_SCHEMA_WITH_CONSTRAINT,
      provenance: 'DERIVED',
      constraints: [{ ...VALID_SCHEMA_WITH_CONSTRAINT.constraints[0], provenance: 'DERIVED' }],
    };
    const provider = stubProvider(() => okResult(JSON.stringify(wrongProvenance)));
    const generator = createProjectSchemaGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate('A whistleblower tip portal, fully anonymous.');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.provenance).toBe('STATED');
      expect(result.value.constraints[0]!.provenance).toBe('STATED');
    }
  });

  it('is deterministic across a cache hit even for a constraint-bearing schema: the generation timestamp does not drift to "now" on re-validation', async () => {
    const withConstraintAndBadFields = {
      ...VALID_SCHEMA_WITH_CONSTRAINT,
      constraints: [
        {
          ...VALID_SCHEMA_WITH_CONSTRAINT.constraints[0],
          source: { type: 'user-authored', location: 'prompt', line: {}, timestamp: {} },
        },
      ],
    };
    const provider = stubProvider(() => okResult(JSON.stringify(withConstraintAndBadFields)));
    const cache = memoryCache();
    const generator = createProjectSchemaGenerator({ provider, cache });
    const prompt = 'A whistleblower tip portal, fully anonymous.';

    const first = await generator.generate(prompt);
    // A real clock tick between calls, so a bug that re-stamps "now" on
    // every finalize() call would be caught rather than accidentally
    // passing because both calls land in the same millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await generator.generate(prompt);

    expect(provider.calls).toHaveLength(1);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
      expect(second.value.constraints[0]!.source.timestamp).toBe(first.value.constraints[0]!.source.timestamp);
    }
  });

  it('falls back via to null when the model returns a via missing phrase (the real Gemini failure mode)', async () => {
    // Exactly what a real Gemini call returned for via on every
    // constraint-bearing generation tried before this fix: an object
    // with none of the one field it was actually asked for.
    const withBrokenVia = {
      sessionId: 'session-test-005',
      title: 'Carpool Coordinator',
      originalPrompt: 'irrelevant for this fixture',
      domains: {
        frontend: { components: [], dependsOn: [] },
        backend: { components: [], dependsOn: [] },
        database: { components: [], dependsOn: [] },
        security: { components: [], dependsOn: [] },
      },
      constraints: [
        {
          id: 'constraint-1',
          relation: 'may-only-import-via',
          subject: { phrase: 'frontend' },
          object: { phrase: 'database' },
          via: {},
          source: { type: 'user-authored', location: 'prompt' },
          confidence: 1,
          lowConfidence: false,
          rawText: 'Frontend must reach the database only through the backend.',
          provenance: 'STATED',
        },
      ],
      provenance: 'STATED',
    };
    const provider = stubProvider(() => okResult(JSON.stringify(withBrokenVia)));
    const generator = createProjectSchemaGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate('A carpool coordinator app for organizing shared rides');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.constraints[0]!.via).toBeNull();
      // subject/object are unaffected - both had a real phrase and pass through.
      expect(result.value.constraints[0]!.subject.status).toBe('UNRESOLVED');
      expect(result.value.constraints[0]!.subject.similarity).toBe(0);
      expect(result.value.constraints[0]!.subject.alternatives).toEqual([]);
    }
  });

  it('keeps a well-formed via (real phrase present) rather than nulling it out', async () => {
    const withGoodVia = {
      sessionId: 'session-test-006',
      title: 'Carpool Coordinator',
      originalPrompt: 'irrelevant for this fixture',
      domains: {
        frontend: { components: [], dependsOn: [] },
        backend: { components: [], dependsOn: [] },
        database: { components: [], dependsOn: [] },
        security: { components: [], dependsOn: [] },
      },
      constraints: [
        {
          id: 'constraint-1',
          relation: 'may-only-import-via',
          subject: { phrase: 'frontend' },
          object: { phrase: 'database' },
          via: { phrase: 'backend' },
          source: { type: 'user-authored', location: 'prompt' },
          confidence: 1,
          lowConfidence: false,
          rawText: 'Frontend must reach the database only through the backend.',
          provenance: 'STATED',
        },
      ],
      provenance: 'STATED',
    };
    const provider = stubProvider(() => okResult(JSON.stringify(withGoodVia)));
    const generator = createProjectSchemaGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate('A carpool coordinator app for organizing shared rides');

    expect(result.ok).toBe(true);
    if (result.ok) {
      const via = result.value.constraints[0]!.via;
      expect(via).not.toBeNull();
      expect(via?.phrase).toBe('backend');
      expect(via?.status).toBe('UNRESOLVED');
      expect(via?.similarity).toBe(0);
      expect(via?.alternatives).toEqual([]);
    }
  });

  it('a subject/object missing phrase is still rejected, not silently defaulted the way via is', async () => {
    const withBrokenSubject = {
      sessionId: 'session-test-007',
      title: 'Carpool Coordinator',
      originalPrompt: 'irrelevant for this fixture',
      domains: {
        frontend: { components: [], dependsOn: [] },
        backend: { components: [], dependsOn: [] },
        database: { components: [], dependsOn: [] },
        security: { components: [], dependsOn: [] },
      },
      constraints: [
        {
          id: 'constraint-1',
          relation: 'must-not-import',
          subject: {},
          object: { phrase: 'database' },
          via: null,
          source: { type: 'user-authored', location: 'prompt' },
          confidence: 1,
          lowConfidence: false,
          rawText: 'Frontend must not import the database.',
          provenance: 'STATED',
        },
      ],
      provenance: 'STATED',
    };
    const provider = stubProvider(() => okResult(JSON.stringify(withBrokenSubject)));
    const generator = createProjectSchemaGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate('A carpool coordinator app for organizing shared rides');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('schema-violation');
      expect(result.error.rejections.some((r) => r.path === '$.constraints[0].subject.phrase')).toBe(true);
    }
  });
});
