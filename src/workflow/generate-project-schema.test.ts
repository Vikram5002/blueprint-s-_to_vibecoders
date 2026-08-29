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

  it('the request schema no longer asks the model for any enum-locked single-value field', () => {
    const asText = JSON.stringify(PROJECT_SCHEMA_JSON_SCHEMA);
    // All seven are set programmatically now (see fillFixedConstraintFields).
    // status/origin failed 3/3 real Gemini attempts; target/reason failed
    // the very next attempt once status/origin stopped being asked for -
    // the general pattern is Gemini does not reliably echo a fixed-value
    // enum field back correctly, so none of them are requested any more.
    expect(asText).not.toContain('"status"');
    expect(asText).not.toContain('"origin"');
    expect(asText).not.toContain('"target"');
    expect(asText).not.toContain('"reason"');
    expect(asText).not.toContain('"line"');
    expect(asText).not.toContain('"timestamp"');
    expect(asText).not.toContain('"provenance"');
    // What still genuinely varies is still requested: similarity (via
    // minimum/maximum, not enum - has never failed a live call),
    // alternatives (real array content), and relation/source.type/location
    // (real per-constraint judgement calls).
    expect(asText).toContain('"similarity"');
    expect(asText).toContain('"alternatives"');
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
});
