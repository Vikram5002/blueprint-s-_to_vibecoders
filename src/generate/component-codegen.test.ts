import { describe, expect, it } from 'vitest';
import {
  createComponentCodeGenerator,
  extractNamedExports,
  selectRelevantConstraints,
  type ComponentGenerationContext,
} from './component-codegen.js';
import type { CompletionProvider, CompletionRequest, CompletionResult } from '../llm/provider.js';
import type { CachedLabel, LabelCache } from '../llm/cache.js';
import type { Constraint } from '../types/constraints.js';

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
    value: { text, model: 'stub-model', usage: { promptTokens: 100, completionTokens: 50, cachedPromptTokens: 0 } },
  };
}

const CONTEXT: ComponentGenerationContext = {
  schemaTitle: 'Test Project',
  component: { id: 'c1', name: 'UserRouter', purpose: 'Exposes user endpoints.' },
  domain: 'backend',
  targetPath: 'backend/src/routes/user-router.ts',
  allowedImportPaths: [],
  availablePackages: ['express'],
  exportContract: 'export default an Express Router',
  relevantConstraints: [],
};

describe('createComponentCodeGenerator', () => {
  it('extracts code from a well-formed {code} JSON response', async () => {
    const provider = stubProvider(() => okResult(JSON.stringify({ code: "console.log('hi');" })));
    const generator = createComponentCodeGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate(CONTEXT);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("console.log('hi');\n");
  });

  it('sends a schema-constrained request, not free text - Gemini forces JSON mode regardless', async () => {
    const provider = stubProvider(() => okResult(JSON.stringify({ code: 'x' })));
    const generator = createComponentCodeGenerator({ provider, cache: memoryCache() });

    await generator.generate(CONTEXT);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.schema).toBeDefined();
  });

  it('fails with unparseable-json when the response is not JSON at all', async () => {
    const provider = stubProvider(() => okResult('not json, just a fenced code block\n```ts\nx\n```'));
    const generator = createComponentCodeGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate(CONTEXT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('unparseable-json');
  });

  it('fails with empty-code when "code" is missing or blank', async () => {
    const provider = stubProvider(() => okResult(JSON.stringify({ code: '   ' })));
    const generator = createComponentCodeGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate(CONTEXT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('empty-code');
  });

  it('propagates a provider-level failure without calling the model twice', async () => {
    const provider = stubProvider(() => ({ ok: false, error: { kind: 'refused', message: 'nope' } }));
    const generator = createComponentCodeGenerator({ provider, cache: memoryCache() });

    const result = await generator.generate(CONTEXT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('provider-error');
    expect(provider.calls).toHaveLength(1);
  });

  it('caches a successful generation and does not call the provider again for the same context', async () => {
    const provider = stubProvider(() => okResult(JSON.stringify({ code: 'cached' })));
    const cache = memoryCache();
    const generator = createComponentCodeGenerator({ provider, cache });

    await generator.generate(CONTEXT);
    await generator.generate(CONTEXT);

    expect(provider.calls).toHaveLength(1);
  });
});

function constraintNaming(subjectPhrase: string, objectPhrase: string): Constraint {
  const resolved = {
    phrase: subjectPhrase,
    status: 'PATH_PATTERN' as const,
    target: `${subjectPhrase}/**`,
    reason: null,
    similarity: 1,
    alternatives: [],
  };
  return {
    id: `${subjectPhrase}-${objectPhrase}`,
    relation: 'must-not-import',
    subject: resolved,
    object: { ...resolved, phrase: objectPhrase, target: `${objectPhrase}/**` },
    via: null,
    source: { type: 'user-authored', location: 'test', line: 1, timestamp: null },
    confidence: 1,
    lowConfidence: false,
    rawText: `${subjectPhrase} must not import ${objectPhrase}`,
    provenance: 'STATED',
  };
}

describe('extractNamedExports', () => {
  it('extracts named function and const exports - the real recipe-store.ts shape from the live recipe-box bug', () => {
    const source = `
import { DatabaseSync } from "node:sqlite";
export const db = new DatabaseSync("recipes.db");
export function insertRecipe(title: string, ingredients: string): number {
  return 1;
}
export function listRecipes(): unknown[] {
  return [];
}
`;
    expect(extractNamedExports(source)).toEqual(['db', 'insertRecipe', 'listRecipes']);
  });

  it('does not invent an export for a name that was only guessed by a consumer, e.g. "recipeDatabase"', () => {
    // The exact real shape from the live bug: no object called `recipeDatabase`
    // exists anywhere in this file, only individual named functions.
    const source = `export function createRecipe() {}\nexport function getRecipe() {}\n`;
    const exported = extractNamedExports(source);
    expect(exported).toEqual(['createRecipe', 'getRecipe']);
    expect(exported).not.toContain('recipeDatabase');
  });

  it('extracts async functions, classes, interfaces, and types', () => {
    const source = `
export async function fetchThing() {}
export class Thing {}
export interface ThingShape {}
export type ThingAlias = ThingShape;
`;
    expect(extractNamedExports(source)).toEqual(['Thing', 'ThingAlias', 'ThingShape', 'fetchThing']);
  });

  it('extracts re-exported and aliased names from an export list', () => {
    const source = `function a() {}\nfunction b() {}\nexport { a, b as renamedB };`;
    expect(extractNamedExports(source)).toEqual(['a', 'renamedB']);
  });

  it('finds nothing exported in a file that only has a default export', () => {
    const source = `export default function middleware(req: unknown, res: unknown, next: () => void) {}\n`;
    expect(extractNamedExports(source)).toEqual([]);
  });
});

describe('selectRelevantConstraints', () => {
  it('matches a constraint whose subject or object phrase contains a given keyword', () => {
    const constraint = constraintNaming('backend/src/middleware', 'backend/src/routes');

    expect(selectRelevantConstraints([constraint], ['security', 'middleware'])).toEqual([constraint]);
    expect(selectRelevantConstraints([constraint], ['backend', 'routes'])).toEqual([constraint]);
  });

  it('excludes a constraint that names neither keyword', () => {
    const constraint = constraintNaming('frontend', 'database');

    expect(selectRelevantConstraints([constraint], ['security', 'middleware'])).toEqual([]);
  });
});
