import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installBuildAndRepair, MAX_BUILD_FIX_ROUNDS, runCommand, summarise, type BuildPhase } from './build-and-repair.js';
import { writeProjectFiles } from './verify-and-regenerate.js';
import { componentId, type ValidatedProjectSchema } from '../types/project-schema.js';
import { validateProjectSchema } from '../workflow/validate-project-schema.js';
import type { CompletionProvider, CompletionRequest } from '../llm/provider.js';
import type { LabelCache } from '../llm/cache.js';

const nullCache: LabelCache = { get: () => undefined, set: () => undefined, flush: async () => true, size: 0 };

function providerFrom(respond: (request: CompletionRequest) => string): CompletionProvider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    calls,
    name: 'stub',
    model: 'stub-model',
    complete: async (request) => {
      calls.push(request);
      return { ok: true, value: { text: JSON.stringify({ code: respond(request) }), model: 'stub-model', usage: { promptTokens: 1, completionTokens: 1, cachedPromptTokens: 0 } } };
    },
  };
}

function oneRouterSchema(): ValidatedProjectSchema {
  const validated = validateProjectSchema({
    sessionId: 'build-and-repair-test',
    title: 'Build and repair test',
    originalPrompt: 'irrelevant for this fixture',
    domains: {
      frontend: { components: [], dependsOn: [] },
      backend: { components: [{ id: componentId('backend', 'Thing', 'p'), name: 'Thing', purpose: 'p' }], dependsOn: [] },
      database: { components: [], dependsOn: [] },
      security: { components: [], dependsOn: [] },
    },
    constraints: [],
    provenance: 'STATED',
  });
  if (!validated.ok) throw new Error('fixture schema invalid');
  return validated.value;
}

/**
 * A "build" that behaves like tsc without needing typescript installed: it
 * prints one tsc-shaped diagnostic against the component file until that
 * file contains the word FIXED. No dependencies, so `npm install` is quick.
 */
const FAKE_TSC = `
const fs = require('node:fs');
const src = fs.readFileSync('backend/src/routes/thing.ts', 'utf8');
if (src.includes('FIXED')) process.exit(0);
console.log('backend/src/routes/thing.ts(1,1): error TS9999: not fixed yet');
process.exit(1);
`;

describe('runCommand', () => {
  it('reports ok and captures output for a passing command, and !ok for a failing one', async () => {
    const passed = await runCommand('node', ['-e', '"console.log(1234)"'], process.cwd());
    expect(passed.ok).toBe(true);
    expect(passed.output).toContain('1234');
    const failed = await runCommand('node', ['-e', '"process.exit(3)"'], process.cwd());
    expect(failed.ok).toBe(false);
  });
});

describe('summarise', () => {
  it('reports each file with its utf8 byte length', () => {
    expect(summarise([{ path: 'a.ts', contents: 'héllo' }])).toEqual([{ path: 'a.ts', bytes: 6 }]);
  });
});

describe('installBuildAndRepair', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vibe-build-and-repair-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it(
    'installs, builds, regenerates the file tsc names with a CORRECTION prompt, rebuilds, and reports phases in order',
    async () => {
      const schema = oneRouterSchema();
      const files = [
        { path: 'package.json', contents: JSON.stringify({ name: 'fixture', private: true, scripts: { build: 'node fake-tsc.js' } }) },
        { path: 'fake-tsc.js', contents: FAKE_TSC },
        { path: 'backend/src/routes/thing.ts', contents: 'export const router = 1;\n' },
      ];
      await writeProjectFiles(root, files, true);
      const provider = providerFrom(() => '// FIXED\nexport const router = 2;\n');
      const phases: BuildPhase[] = [];

      const result = await installBuildAndRepair({ schema, llm: { provider, cache: nullCache }, root, files, onPhase: (phase) => phases.push(phase) });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(phases).toEqual(['installing', 'building', 'build-regenerating', 'build-reverifying']);
      expect(result.value.build).toEqual({ installOk: true, buildOk: true });
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]?.user).toContain('CORRECTION REQUIRED');
      expect(provider.calls[0]?.user).toContain('TS9999');
      expect(result.value.regenerationLog).toMatchObject([{ targetPath: 'backend/src/routes/thing.ts', origin: 'build-failure', outcome: 'fixed' }]);
      expect(result.value.files.find((f) => f.path === 'backend/src/routes/thing.ts')?.contents).toContain('FIXED');
      expect(await readFile(join(root, 'backend', 'src', 'routes', 'thing.ts'), 'utf8')).toContain('FIXED');
    },
    60_000,
  );

  it(
    'gives up after MAX_BUILD_FIX_ROUNDS and reports the build failure with its output',
    async () => {
      const schema = oneRouterSchema();
      const files = [
        { path: 'package.json', contents: JSON.stringify({ name: 'fixture', private: true, scripts: { build: 'node fake-tsc.js' } }) },
        { path: 'fake-tsc.js', contents: FAKE_TSC },
        { path: 'backend/src/routes/thing.ts', contents: 'export const router = 1;\n' },
      ];
      await writeProjectFiles(root, files, true);
      const provider = providerFrom(() => 'export const router = 3; // still broken\n');

      const result = await installBuildAndRepair({ schema, llm: { provider, cache: nullCache }, root, files });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(provider.calls).toHaveLength(MAX_BUILD_FIX_ROUNDS);
      expect(result.value.build.buildOk).toBe(false);
      expect(result.value.build.failureOutput).toContain('TS9999');
      expect(result.value.regenerationLog.map((a) => a.outcome)).toEqual(['still-violating', 'still-violating']);
    },
    60_000,
  );
});
