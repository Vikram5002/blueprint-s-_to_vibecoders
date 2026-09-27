import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateProject } from './generate-project.js';
import { componentTargetPath, type GeneratedFile } from './assemble.js';
import type { CompletionProvider } from '../llm/provider.js';
import { validateProjectSchema } from '../workflow/validate-project-schema.js';
import type { ValidatedProjectSchema } from '../types/project-schema.js';

function todoSchema(): ValidatedProjectSchema {
  const raw: unknown = JSON.parse(readFileSync(new URL('../workflow/fixtures/project-schema/todo-app.json', import.meta.url), 'utf8'));
  const validated = validateProjectSchema(raw);
  if (!validated.ok) throw new Error('fixture invalid');
  return validated.value;
}

const cache = { get: () => undefined, set: () => {}, flush: async () => true, size: 0 };

function countingProvider(failAfter = Infinity): { provider: CompletionProvider; calls: () => number } {
  let calls = 0;
  const provider: CompletionProvider = {
    name: 'stub',
    model: 'stub',
    complete: async () => {
      calls += 1;
      if (calls > failAfter) return { ok: false, error: { reason: 'provider-error', message: 'daily quota exhausted', retryable: false } };
      return { ok: true, value: { text: JSON.stringify({ code: `export const n = ${calls};\n` }), model: 'stub', usage: { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 } } };
    },
  };
  return { provider, calls: () => calls };
}

describe('generateProject - continuing a half-built project', () => {
  it('saves each component as it is generated, so an interrupted run keeps its work', async () => {
    const saved: GeneratedFile[] = [];
    const { provider } = countingProvider(2);
    const result = await generateProject(todoSchema(), { provider, cache, skipCache: true, onComponentFile: (file) => void saved.push(file) });
    expect(result.ok).toBe(false);
    expect(saved).toHaveLength(2);
  });

  it('reuses the saved components and asks the model only for the rest', async () => {
    const schema = todoSchema();
    const saved: GeneratedFile[] = [];
    await generateProject(schema, { provider: countingProvider(2).provider, cache, skipCache: true, onComponentFile: (file) => void saved.push(file) });

    const resumed = countingProvider();
    const result = await generateProject(schema, { provider: resumed.provider, cache, skipCache: true, existingFiles: saved });
    if (!result.ok) throw new Error(JSON.stringify(result.error));

    const total = (['database', 'backend', 'security', 'frontend'] as const).reduce((n, d) => n + schema.domains[d].components.length, 0);
    expect(resumed.calls()).toBe(total - saved.length);
    for (const file of saved) expect(result.value.files).toContainEqual(file);
    const first = schema.domains.database.components[0] ?? schema.domains.backend.components[0];
    expect(first).toBeDefined();
  });

  it('reuses by target path, so a component is never generated twice', async () => {
    const schema = todoSchema();
    const component = schema.domains.backend.components[0];
    if (component === undefined) throw new Error('fixture has no backend');
    const existing = { path: componentTargetPath('backend', component), contents: 'export const kept = true;\n' };
    const result = await generateProject(schema, { provider: countingProvider().provider, cache, skipCache: true, existingFiles: [existing] });
    if (!result.ok) throw new Error('failed');
    expect(result.value.files.filter((f) => f.path === existing.path)).toEqual([existing]);
  });
});
