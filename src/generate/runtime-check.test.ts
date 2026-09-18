import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routeResultsFor, runRuntimeCheck } from './runtime-check.js';
import { componentId, type ValidatedProjectSchema } from '../types/project-schema.js';
import { validateProjectSchema } from '../workflow/validate-project-schema.js';

/**
 * A stand-in for the built Express server: `node:http`, not express, since
 * the root package has no express dependency and the checker only ever
 * speaks HTTP. Reads PORT like the templated entry point does, answers
 * /api/good with 200 and /api/bad with a 500, anything else 404.
 */
const FIXTURE_SERVER = `
const http = require('node:http');
const port = Number(process.env.PORT);
http.createServer((req, res) => {
  if (req.url.startsWith('/api/good')) { res.writeHead(200); res.end('ok'); return; }
  if (req.url.startsWith('/api/bad')) { res.writeHead(500); res.end('boom'); return; }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', () => console.log('listening on ' + port));
`;

function schemaWith(backendNames: readonly string[], securityNames: readonly string[]): ValidatedProjectSchema {
  const component = (domain: 'backend' | 'security', name: string) => ({ id: componentId(domain, name, `${name} purpose`), name, purpose: `${name} purpose` });
  const validated = validateProjectSchema({
    sessionId: 'runtime-check-test',
    title: 'Runtime check test',
    originalPrompt: 'irrelevant for this fixture',
    domains: {
      frontend: { components: [], dependsOn: [] },
      backend: { components: backendNames.map((name) => component('backend', name)), dependsOn: [] },
      database: { components: [], dependsOn: [] },
      security: { components: securityNames.map((name) => component('security', name)), dependsOn: [] },
    },
    constraints: [],
    provenance: 'STATED',
  });
  if (!validated.ok) throw new Error(`fixture schema invalid: ${JSON.stringify(validated.error)}`);
  return validated.value;
}

describe('runRuntimeCheck', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vibe-runtime-check-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeFixtureServer(): Promise<void> {
    await mkdir(join(root, 'dist', 'backend', 'src'), { recursive: true });
    await writeFile(join(root, 'dist', 'backend', 'src', 'index.js'), FIXTURE_SERVER, 'utf8');
  }

  it('starts the server, requests both spellings of every backend route, and fails only the 5xx one', async () => {
    await writeFixtureServer();
    const schema = schemaWith(['Good', 'Bad'], ['Guard']);

    const result = await runRuntimeCheck(root, schema, { timeoutMs: 10_000 });

    expect(result.started).toBe(true);
    expect(result.routes.map((r) => [r.path, r.status])).toEqual([
      ['/api/good', 200],
      ['/api/good/', 200],
      ['/api/bad', 500],
      ['/api/bad/', 500],
    ]);
    expect(result.ok).toBe(false);
    expect(result.serverOutput).toContain('listening on');

    const perComponent = routeResultsFor(schema, result);
    const byName = new Map(perComponent.map((entry) => [entry.component.name, entry]));
    expect(byName.get('Good')?.passed).toBe(true);
    expect(byName.get('Good')?.targetPath).toBe('backend/src/routes/good.ts');
    expect(byName.get('Bad')?.passed).toBe(false);
    // A security middleware runs on every request, so it is judged on every route.
    expect(byName.get('Guard')?.routes.length).toBe(4);
    expect(byName.get('Guard')?.passed).toBe(false);
    expect(byName.get('Guard')?.targetPath).toBe('backend/src/middleware/guard.ts');
  }, 30_000);

  it('passes when every route answers below 500, and a security component passes with them', async () => {
    await writeFixtureServer();
    const schema = schemaWith(['Good'], ['Guard']);
    const result = await runRuntimeCheck(root, schema, { timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    expect(routeResultsFor(schema, result).every((entry) => entry.passed)).toBe(true);
  }, 30_000);

  it('a project with no backend components is a start-only check', async () => {
    await writeFixtureServer();
    const schema = schemaWith([], ['Guard']);
    const result = await runRuntimeCheck(root, schema, { timeoutMs: 10_000 });
    expect(result).toMatchObject({ started: true, routes: [], ok: true });
    expect(routeResultsFor(schema, result)).toMatchObject([{ domain: 'security', passed: true, routes: [] }]);
  }, 30_000);

  it('reports started=false with every route unanswered when the entry point is missing', async () => {
    const schema = schemaWith(['Good'], []);
    const result = await runRuntimeCheck(root, schema, { timeoutMs: 2_000 });
    expect(result.started).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.routes.every((r) => r.status === null)).toBe(true);
    expect(routeResultsFor(schema, result)[0]?.passed).toBe(false);
  });

  it('reports started=false when the server exits before listening', async () => {
    await mkdir(join(root, 'dist', 'backend', 'src'), { recursive: true });
    await writeFile(join(root, 'dist', 'backend', 'src', 'index.js'), "console.error('crashed on boot'); process.exit(1);", 'utf8');
    const schema = schemaWith(['Good'], []);
    const result = await runRuntimeCheck(root, schema, { timeoutMs: 5_000 });
    expect(result.started).toBe(false);
    expect(result.serverOutput).toContain('crashed on boot');
  }, 15_000);
});
