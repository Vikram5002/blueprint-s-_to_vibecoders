import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergePackageJson, NOT_A_VIBECODER_PROJECT, readProjectFiles, schemaFromProjectFiles } from './import-project.js';

const identity = { sessionId: 'import-test', title: 'Imported shop', prompt: 'Imported from a folder' };

describe('import a hand-continued project', () => {
  let root: string;
  const put = async (path: string, contents: string): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents, 'utf8');
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vibe-import-'));
    await put('package.json', '{"name":"shop","dependencies":{"express":"^4.19.2","zod":"^3.23.0"}}');
    await put('backend/src/index.ts', 'import express from "express";');
    await put('backend/src/routes/product-catalog-api.ts', 'export const router = 1;');
    await put('backend/src/middleware/jwt-auth-guard.ts', 'export function middleware() {}');
    await put('backend/src/db/products-store.ts', 'export const db = 1;');
    await put('backend/src/lib/money.ts', 'export const cents = (n: number) => n * 100;');
    await put('frontend/src/pages/product-list.tsx', 'export function ProductList() { return null; }');
    await put('generated.blueprint', 'The frontend must not directly access the database.\n');
    await put('node_modules/express/index.js', 'ignored');
    await put('dist/backend/src/index.js', 'ignored');
    await put('logo.png', 'binary-ish');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads source files and skips dependencies, build output and binaries', async () => {
    const paths = (await readProjectFiles(root)).map((f) => f.path);
    expect(paths).toContain('backend/src/lib/money.ts');
    expect(paths).toContain('generated.blueprint');
    expect(paths.some((p) => p.startsWith('node_modules/') || p.startsWith('dist/'))).toBe(false);
    expect(paths).not.toContain('logo.png');
  });

  it('rebuilds the plan from the folder layout, one component per file', async () => {
    const imported = schemaFromProjectFiles(await readProjectFiles(root), identity);
    if (!imported.ok) throw new Error(imported.error);
    const { domains } = imported.value.schema;
    expect(domains.backend.components.map((c) => c.name)).toEqual(['Product Catalog Api']);
    expect(domains.security.components.map((c) => c.name)).toEqual(['Jwt Auth Guard']);
    expect(domains.database.components.map((c) => c.name)).toEqual(['Products Store']);
    expect(domains.frontend.components.map((c) => c.name)).toEqual(['Product List']);
    expect(domains.frontend.dependsOn).toEqual(['backend']);
    expect(domains.backend.dependsOn).toEqual(['database']);
  });

  it("keeps the project's own architecture rules", async () => {
    const imported = schemaFromProjectFiles(await readProjectFiles(root), identity);
    if (!imported.ok) throw new Error(imported.error);
    expect(imported.value.schema.constraints.length + imported.value.rejectedRules.length).toBe(1);
  });

  it('refuses a folder that is not in this layout, and says why', () => {
    const result = schemaFromProjectFiles([{ path: 'src/app.py', contents: 'print(1)' }], identity);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.startsWith(NOT_A_VIBECODER_PROJECT)).toBe(true);
      expect(result.error).toContain('backend/src/routes');
      expect(result.error).toContain('Analysis view');
    }
  });
});

describe('mergePackageJson', () => {
  it('adds what the plan needs and keeps every dependency the person added', () => {
    const merged = JSON.parse(
      mergePackageJson(
        '{"name":"shop","dependencies":{"express":"^4.18.0","zod":"^3.23.0"}}',
        '{"name":"generated-backend","scripts":{"build":"tsc"},"dependencies":{"express":"^4.19.2","react":"^18.3.1"}}',
      ),
    ) as { name: string; scripts: Record<string, string>; dependencies: Record<string, string> };
    expect(merged.name).toBe('shop');
    expect(merged.scripts.build).toBe('tsc');
    expect(merged.dependencies).toEqual({ express: '^4.18.0', react: '^18.3.1', zod: '^3.23.0' });
  });
});
