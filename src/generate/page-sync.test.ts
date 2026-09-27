import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planPageSync, generatePageSyncFiles } from './page-sync.js';
import type { CanvasElement, PageLayout } from './canvas-layout.js';
import type { CompletionProvider } from '../llm/provider.js';
import { validateProjectSchema } from '../workflow/validate-project-schema.js';
import type { ValidatedProjectSchema } from '../types/project-schema.js';

function todoSchema(): ValidatedProjectSchema {
  const raw: unknown = JSON.parse(readFileSync(new URL('../workflow/fixtures/project-schema/todo-app.json', import.meta.url), 'utf8'));
  const validated = validateProjectSchema(raw);
  if (!validated.ok) throw new Error('fixture invalid');
  return validated.value;
}

function element(overrides: Partial<CanvasElement> & Pick<CanvasElement, 'type'>): CanvasElement {
  return { id: 'el-1', x: 0, y: 0, width: 200, height: 40, label: 'x', colorToken: 'primary', ...overrides };
}

const loginPage: PageLayout = {
  id: 'p',
  pageName: 'Login Page',
  elements: [
    element({ id: 'el-1', type: 'email', label: 'Email', field: 'email' }),
    element({ id: 'el-2', type: 'password', label: 'Password' }),
    element({ id: 'el-3', type: 'toggle', label: 'Remember me' }),
    element({ id: 'el-4', type: 'button', label: 'Sign in' }),
  ],
};

describe('planPageSync', () => {
  it('adds a store and an API built from the page fields', () => {
    const planned = planPageSync(todoSchema(), loginPage);
    if (!planned.ok) throw new Error(JSON.stringify(planned.error));
    const { schema, store, api } = planned.value;
    expect(store.name).toBe('Login Page Store');
    expect(api.name).toBe('Login Page API');
    expect(store.purpose).toContain('login_page_submissions');
    expect(store.purpose).toContain('email (email');
    expect(store.purpose).toContain('scrypt');
    expect(api.purpose).toContain('/api/login-page-api');
    expect(api.purpose).toContain('never including password');
    expect(schema.domains.database.components).toContainEqual(store);
    expect(schema.domains.backend.components).toContainEqual(api);
    expect(schema.domains.backend.dependsOn).toContain('database');
  });

  it('replaces the store and API on a second sync instead of adding more', () => {
    const first = planPageSync(todoSchema(), loginPage);
    if (!first.ok) throw new Error('first sync failed');
    const changed: PageLayout = { ...loginPage, elements: [...loginPage.elements, element({ id: 'el-5', type: 'input', label: 'Nickname' })] };
    const second = planPageSync(first.value.schema, changed);
    if (!second.ok) throw new Error('second sync failed');
    const names = second.value.schema.domains.backend.components.map((c) => c.name);
    expect(names.filter((n) => n === 'Login Page API')).toHaveLength(1);
    expect(second.value.api.purpose).toContain('nickname');
  });

  it('refuses a page with no inputs', () => {
    expect(planPageSync(todoSchema(), { ...loginPage, elements: [element({ type: 'heading' })] })).toEqual({
      ok: false,
      error: { reason: 'no-form-fields' },
    });
  });
});

describe('generatePageSyncFiles', () => {
  it('generates the store before the API and re-derives the wiring', async () => {
    const planned = planPageSync(todoSchema(), loginPage);
    if (!planned.ok) throw new Error('plan failed');
    const asked: string[] = [];
    const provider: CompletionProvider = {
      name: 'stub',
      model: 'stub',
      complete: async (request) => {
        asked.push(request.user);
        return { ok: true, value: { text: JSON.stringify({ code: 'export const x = 1;\n' }), model: 'stub', usage: { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 } } };
      },
    };
    const cache = { get: () => undefined, set: () => {}, flush: async () => true, size: 0 };
    const result = await generatePageSyncFiles(planned.value, [{ path: 'README.md', contents: 'keep me' }], { provider, cache, skipCache: true });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const paths = result.value.map((f) => f.path);
    expect(paths).toContain('backend/src/db/login-page-store.ts');
    expect(paths).toContain('backend/src/routes/login-page-api.ts');
    expect(paths).toContain('README.md');
    const entry = result.value.find((f) => f.path === 'backend/src/index.ts')?.contents ?? '';
    expect(entry).toContain("app.use('/api/login-page-api'");
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain('Login Page Store');
    expect(asked[1]).toContain('Login Page API');
  });
});
