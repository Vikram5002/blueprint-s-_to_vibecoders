import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attributeBuildFailure,
  parseTscDiagnostics,
  regenerateForBuildFailure,
} from './verify-and-regenerate.js';
import { componentId, type ValidatedProjectSchema } from '../types/project-schema.js';
import { validateProjectSchema } from '../workflow/validate-project-schema.js';
import type { GeneratedFile } from './assemble.js';
import type { CompletionProvider, CompletionRequest } from '../llm/provider.js';
import type { CachedLabel, LabelCache } from '../llm/cache.js';

const require = createRequire(import.meta.url);

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

function providerFrom(respond: (request: CompletionRequest) => string): CompletionProvider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    calls,
    name: 'stub',
    model: 'stub-model',
    complete: async (request) => {
      calls.push(request);
      return {
        ok: true,
        value: {
          text: JSON.stringify({ code: respond(request) }),
          model: 'stub-model',
          usage: { promptTokens: 10, completionTokens: 10, cachedPromptTokens: 0 },
        },
      };
    },
  };
}

function buildTwoComponentSchema(): ValidatedProjectSchema {
  const candidate = {
    sessionId: 'build-failure-test',
    title: 'Build failure retry test',
    originalPrompt: 'irrelevant for this fixture',
    domains: {
      frontend: { components: [], dependsOn: [] },
      backend: {
        components: [
          { id: componentId('backend', 'RecipeApiService', 'recipe-api-service'), name: 'RecipeApiService', purpose: 'x' },
          { id: componentId('backend', 'UserApiService', 'user-api-service'), name: 'UserApiService', purpose: 'y' },
        ],
        dependsOn: [],
      },
      database: { components: [], dependsOn: [] },
      security: { components: [], dependsOn: [] },
    },
    constraints: [],
    provenance: 'STATED' as const,
  };
  const validated = validateProjectSchema(candidate);
  if (!validated.ok) throw new Error(`fixture schema invalid: ${JSON.stringify(validated.error)}`);
  return validated.value;
}

// The exact live diagnostic shape from docs/GENERATION.md's own recorded
// build failure - reproduced verbatim, not paraphrased.
const REAL_TSC_OUTPUT_SINGLE_FILE = [
  '',
  '> generated-backend@0.0.0 build',
  '> tsc',
  '',
  "backend/src/routes/recipe-api-service.ts(26,36): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
].join('\n');

const REAL_TSC_OUTPUT_MULTI_FILE = [
  "backend/src/routes/recipe-api-service.ts(26,36): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  "backend/src/routes/user-api-service.ts(10,12): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
].join('\n');

describe('parseTscDiagnostics', () => {
  it('parses real tsc diagnostic lines, ignoring surrounding npm/tsc chatter', () => {
    const diagnostics = parseTscDiagnostics(REAL_TSC_OUTPUT_SINGLE_FILE);
    expect(diagnostics).toEqual([
      {
        file: 'backend/src/routes/recipe-api-service.ts',
        line: 26,
        code: 'TS2345',
        message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
      },
    ]);
  });

  it('parses every diagnostic line when multiple files are named', () => {
    const diagnostics = parseTscDiagnostics(REAL_TSC_OUTPUT_MULTI_FILE);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((d) => d.file)).toEqual([
      'backend/src/routes/recipe-api-service.ts',
      'backend/src/routes/user-api-service.ts',
    ]);
  });

  it('returns an empty array for output with no real tsc diagnostic lines', () => {
    expect(parseTscDiagnostics('Error: something else entirely went wrong\n')).toEqual([]);
  });
});

describe('attributeBuildFailure', () => {
  const schema = buildTwoComponentSchema();

  it('attributes a single-file failure to its real component', () => {
    const result = attributeBuildFailure(schema, parseTscDiagnostics(REAL_TSC_OUTPUT_SINGLE_FILE));
    expect(result.attributed).toHaveLength(1);
    const [only] = result.attributed;
    expect(only?.component.name).toBe('RecipeApiService');
    expect(only?.domain).toBe('backend');
    expect(only?.targetPath).toBe('backend/src/routes/recipe-api-service.ts');
    expect(only?.diagnostics).toHaveLength(1);
  });

  it('attributes each file separately when diagnostics span several component files', () => {
    const result = attributeBuildFailure(schema, parseTscDiagnostics(REAL_TSC_OUTPUT_MULTI_FILE));
    expect(result.attributed.map((a) => a.component.name)).toEqual(['RecipeApiService', 'UserApiService']);
    expect(result.unattributedFiles).toEqual([]);
  });

  it('orders attributed files by generation order, dependencies first', () => {
    const order = ['backend/src/routes/user-api-service.ts', 'backend/src/routes/recipe-api-service.ts'];
    const result = attributeBuildFailure(schema, parseTscDiagnostics(REAL_TSC_OUTPUT_MULTI_FILE), order);
    expect(result.attributed.map((a) => a.component.name)).toEqual(['UserApiService', 'RecipeApiService']);
  });

  it('never attributes a file that maps to no schema component (a templated entry point)', () => {
    const entryPointOutput = "backend/src/index.ts(5,3): error TS2304: Cannot find name 'express'.";
    const result = attributeBuildFailure(schema, parseTscDiagnostics(entryPointOutput));
    expect(result.attributed).toEqual([]);
    expect(result.unattributedFiles).toEqual(['backend/src/index.ts']);
  });

  it('attributes nothing when there are no parsed diagnostics at all', () => {
    expect(attributeBuildFailure(schema, []).attributed).toEqual([]);
  });
});

describe('regenerateForBuildFailure', () => {
  const schema = buildTwoComponentSchema();
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vibe-build-failure-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const BROKEN_RECIPE_SERVICE = [
    'export function createRecipe(title: string): number {',
    "  return parseAndStore(title);", // calls an undefined function - a real compile error
    '}',
  ].join('\n');

  const FIXED_RECIPE_SERVICE = [
    'export function createRecipe(title: string): number {',
    '  return title.length;',
    '}',
  ].join('\n');

  const OTHER_SERVICE = ['export function listUsers(): string[] {', '  return [];', '}'].join('\n');

  function baseFiles(): readonly GeneratedFile[] {
    return [
      { path: 'backend/src/routes/recipe-api-service.ts', contents: `${BROKEN_RECIPE_SERVICE}\n` },
      { path: 'backend/src/routes/user-api-service.ts', contents: `${OTHER_SERVICE}\n` },
    ];
  }

  it('fires exactly one retry when the build failure attributes cleanly to a single component, and the corrected output actually builds', async () => {
    const provider = providerFrom((request) => {
      expect(request.user).toContain('CORRECTION REQUIRED');
      expect(request.user).toContain('TS2304');
      expect(request.user).toContain('npm run build');
      return FIXED_RECIPE_SERVICE;
    });

    const buildOutput =
      "backend/src/routes/recipe-api-service.ts(2,10): error TS2304: Cannot find name 'parseAndStore'.";

    const result = await regenerateForBuildFailure(
      schema,
      { provider, cache: memoryCache(), root },
      baseFiles(),
      buildOutput,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.attempted).toHaveLength(1);
    expect(result.value.attempted[0]?.component.name).toBe('RecipeApiService');
    const snippet = result.value.attempted[0]?.firstAttemptViolation.evidence[0]?.snippet;
    expect(snippet).toContain("Cannot find name 'parseAndStore'");
    // The literal offending source line travels with the diagnostic.
    expect(snippet).toContain('return parseAndStore(title);');
    // Exactly one call to the provider - one retry, never more.
    expect(provider.calls).toHaveLength(1);

    const recipeFile = result.value.files.find((f) => f.path === 'backend/src/routes/recipe-api-service.ts');
    expect(recipeFile?.contents).toBe(`${FIXED_RECIPE_SERVICE}\n`);
    // The sibling file, never involved in the failure, is untouched.
    const userFile = result.value.files.find((f) => f.path === 'backend/src/routes/user-api-service.ts');
    expect(userFile?.contents).toBe(`${OTHER_SERVICE}\n`);

    // Not just "the stub returned different text" - the corrected file
    // actually compiles with the repo's own real tsc binary.
    const tempDir = await mkdtemp(join(tmpdir(), 'vibe-build-failure-compile-'));
    try {
      for (const file of result.value.files) {
        const fullPath = join(tempDir, ...file.path.split('/'));
        await mkdir(join(fullPath, '..'), { recursive: true });
        await writeFile(fullPath, file.contents, 'utf8');
      }
      await writeFile(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify(
          { compilerOptions: { target: 'ES2020', module: 'commonjs', strict: true, skipLibCheck: true, noEmit: true }, include: ['backend/**/*.ts'] },
          null,
          2,
        ),
        'utf8',
      );
      const tscBin = require.resolve('typescript/bin/tsc');
      expect(() => execFileSync(process.execPath, [tscBin, '-p', tempDir], { cwd: tempDir, stdio: 'pipe' })).not.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('regenerates every failing component file once, each with only its own diagnostics, when the failure spans several files', async () => {
    const provider = providerFrom((request) =>
      request.user.includes('Component: RecipeApiService') ? FIXED_RECIPE_SERVICE : OTHER_SERVICE,
    );

    const multiFileOutput = [
      "backend/src/routes/recipe-api-service.ts(2,10): error TS2304: Cannot find name 'parseAndStore'.",
      "backend/src/routes/user-api-service.ts(1,1): error TS2304: Cannot find name 'somethingUndefined'.",
    ].join('\n');

    const result = await regenerateForBuildFailure(
      schema,
      { provider, cache: memoryCache(), root },
      baseFiles(),
      multiFileOutput,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.attempted.map((a) => a.component.name)).toEqual(['RecipeApiService', 'UserApiService']);
    expect(provider.calls).toHaveLength(2);
    // Each retry sees its own file's error, never the other file's.
    expect(provider.calls[0]?.user).toContain('parseAndStore');
    expect(provider.calls[0]?.user).not.toContain('somethingUndefined');
    expect(provider.calls[1]?.user).toContain('somethingUndefined');
    expect(provider.calls[1]?.user).not.toContain('parseAndStore');
  });

  it('never regenerates anything when only a templated entry point is named', async () => {
    const provider = providerFrom(() => FIXED_RECIPE_SERVICE);
    const result = await regenerateForBuildFailure(
      schema,
      { provider, cache: memoryCache(), root },
      baseFiles(),
      "backend/src/index.ts(5,3): error TS2304: Cannot find name 'express'.",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempted).toEqual([]);
    expect(provider.calls).toHaveLength(0);
    expect(result.value.files).toEqual(baseFiles());
  });

  it('never regenerates anything when the build failure cannot be parsed into any real diagnostic at all', async () => {
    const provider = providerFrom(() => FIXED_RECIPE_SERVICE);

    const result = await regenerateForBuildFailure(
      schema,
      { provider, cache: memoryCache(), root },
      baseFiles(),
      'Error: the tsc process crashed with no structured output',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempted).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });
});
