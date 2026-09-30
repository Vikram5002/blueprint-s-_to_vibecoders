import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blueprintText, domainRuleLines, planConstraints } from './plan-rules.js';
import { verifyGeneratedProject, writeProjectFiles } from './verify-and-regenerate.js';
import { detectServiceLocatorEvasion } from './detect-service-locator-evasion.js';
import { validateProjectSchema } from '../workflow/validate-project-schema.js';
import { componentId, type ValidatedProjectSchema } from '../types/project-schema.js';

function component(name: string, purpose: string): { id: string; name: string; purpose: string } {
  return { id: componentId('backend', name, purpose), name, purpose };
}

/** backend -> database, backend -> security; nothing else granted. A business rule that compiles to nothing. */
function schema(): ValidatedProjectSchema {
  const candidate = {
    sessionId: 'plan-rules-test',
    title: 'Plan rules',
    originalPrompt: 'test',
    domains: {
      frontend: { components: [], dependsOn: [] },
      backend: { components: [component('Orders API', 'Lists orders.')], dependsOn: ['database', 'security'] },
      database: { components: [component('orders table', 'Stores orders.')], dependsOn: [] },
      security: { components: [component('Auth Guard', 'Checks the session.')], dependsOn: [] },
    },
    constraints: [],
    provenance: 'STATED' as const,
  };
  const validated = validateProjectSchema(candidate);
  if (!validated.ok) throw new Error(JSON.stringify(validated.error));
  return validated.value;
}

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vibe-plan-rules-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('plan rules', () => {
  it('turns every dependency the plan does not grant into a path rule, for populated domains only', () => {
    expect([...domainRuleLines(schema())].sort()).toEqual([
      'backend/src/db must not import backend/src/middleware',
      'backend/src/db must not import backend/src/routes',
      'backend/src/middleware must not import backend/src/db',
      'backend/src/middleware must not import backend/src/routes',
    ]);
    expect(blueprintText(schema())).toContain('backend/src/middleware must not import backend/src/db');
  });

  it('makes the verifier catch an import the plan forbids, which the prose-only check never saw', async () => {
    await writeProjectFiles(
      root,
      [
        { path: 'backend/src/db/orders-table.ts', contents: 'export function listOrders(): string[] { return []; }\n' },
        { path: 'backend/src/routes/orders-api.ts', contents: "import { listOrders } from '../db/orders-table';\nexport const router = listOrders;\n" },
        { path: 'backend/src/middleware/auth-guard.ts', contents: "import { listOrders } from '../db/orders-table';\nexport const middleware = listOrders;\n" },
      ],
      false,
    );
    const verified = await verifyGeneratedProject(root, schema());
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.map((violation) => violation.constraint.rawText)).toEqual([
      'backend/src/middleware must not import backend/src/db',
    ]);
  }, 60_000);

  it('gives the locator scan resolved rules, so a runtime lookup of a forbidden export is caught', () => {
    const files = [
      { path: 'backend/src/db/orders-table.ts', contents: 'export function listOrders(): string[] { return []; }\n' },
      { path: 'backend/src/middleware/auth-guard.ts', contents: "export const middleware = (req: { app: { get(k: string): unknown } }) => req.app.get('listOrders');\n" },
    ];
    const findings = detectServiceLocatorEvasion(files, planConstraints(schema()));
    expect(findings.map((finding) => finding.file)).toEqual(['backend/src/middleware/auth-guard.ts']);
  });
});
