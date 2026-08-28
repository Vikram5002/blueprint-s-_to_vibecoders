import { describe, expect, it } from 'vitest';
import {
  analyzePrompt,
  createProjectSchemaGenerator,
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
    const malformed = { ...VALID_SCHEMA_NO_CONSTRAINTS, provenance: 'DERIVED' };
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
});
