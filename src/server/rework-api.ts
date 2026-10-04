/**
 * POST /api/rework - a proposed new version of one file of the analysed
 * project, for the VS Code extension to show as a diff. Nothing is written:
 * the extension applies the proposal only when the person clicks Keep.
 *
 * The violations come from the analysis the server already holds (the same
 * list /api/violations serves), never from the client, so a client cannot
 * make the model "fix" a rule the project does not have.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { Hono } from 'hono';
import type { CompletionProvider } from '../llm/provider.js';
import { reworkFile, type ReworkHelper, type ReworkViolation } from '../generate/rework-file.js';
import { extractNamedExports } from '../generate/component-codegen.js';
import { buildViolationsResponse } from './violations-api.js';
import type { AnalysisContext } from './context.js';

export interface ReworkRouteDeps {
  readonly context: () => AnalysisContext;
  /** The code model; null when none is configured (the route then answers 503). */
  readonly provider: CompletionProvider | null;
}

interface ReworkBody {
  readonly path: string;
  readonly source?: string;
  readonly instruction?: string;
}

function parseBody(body: unknown): ReworkBody | string {
  if (typeof body !== 'object' || body === null) return 'expected a JSON object';
  const { path, source, instruction } = body as Record<string, unknown>;
  if (typeof path !== 'string' || path.trim() === '') return '"path" must be a repo-relative file path';
  if (source !== undefined && typeof source !== 'string') return '"source" must be a string when given';
  if (instruction !== undefined && typeof instruction !== 'string') return '"instruction" must be a string when given';
  return { path, ...(source === undefined ? {} : { source }), ...(instruction === undefined ? {} : { instruction }) };
}

/** Repo-relative posix path, or null when it would leave the project root. */
export function normaliseRepoPath(root: string, path: string): string | null {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split('\\').join('/');
}

/** The violations whose evidence starts in `path`, with only that file's lines and the modules it must not reach. */
export function violationsForFile(context: AnalysisContext, path: string): ReworkViolation[] {
  return buildViolationsResponse(context).violations.flatMap((violation) => {
    const edges = violation.edges.filter((edge) => edge.fromFile === path);
    const evidence = edges.flatMap((edge) => edge.evidence.filter((e) => e.file === path).map((e) => ({ line: e.line, snippet: e.snippet })));
    if (evidence.length === 0) return [];
    const forbidden = [...new Set(edges.map((edge) => edge.toModule))];
    return [{ ruleText: violation.constraint.rawText, explanation: violation.explanation, evidence, forbidden }];
  });
}

const MAX_HELPERS = 5;

function inside(file: string, module: string): boolean {
  const m = module.replace(/\/+$/, '');
  return m === '.' || file === m || file.startsWith(`${m}/`);
}

/**
 * Files that already import what `path` is forbidden to import, from
 * outside both its own module and the forbidden one, and that break no rule
 * themselves - likely the layer the rules want `path` to go through.
 */
export async function helpersForFile(context: AnalysisContext, path: string): Promise<ReworkHelper[]> {
  const all = buildViolationsResponse(context).violations;
  const violators = new Set(all.flatMap((v) => v.edges.map((edge) => edge.fromFile)));
  const mine = all.flatMap((v) => v.edges.filter((edge) => edge.fromFile === path));
  const graph = context.graph.graph;
  const candidates = new Set<string>();
  for (const edge of mine) {
    if (!graph.hasNode(edge.toFile)) continue;
    for (const importer of graph.inNeighbors(edge.toFile)) {
      if (importer === path || violators.has(importer)) continue;
      if (inside(importer, edge.fromModule) || inside(importer, edge.toModule)) continue;
      candidates.add(importer);
    }
  }
  const picked = [...candidates].sort().slice(0, MAX_HELPERS);
  return Promise.all(
    picked.map(async (file) => {
      const text = await readFile(resolve(context.root, file), 'utf8').catch(() => '');
      return { path: file, exports: [...extractNamedExports(text)] };
    }),
  );
}

function statedRules(context: AnalysisContext): string[] {
  const fromViolations = buildViolationsResponse(context).violations.map((v) => v.constraint.rawText);
  const fromIntent = context.intent.constraints.map((c) => c.rawText);
  return [...new Set([...fromIntent, ...fromViolations])];
}

export function createReworkRoutes(deps: ReworkRouteDeps): Hono {
  const app = new Hono();

  // Which rules a file breaks - so the extension can show them before asking for a rework.
  app.get('/violations', (c) => {
    const context = deps.context();
    const path = normaliseRepoPath(context.root, c.req.query('path') ?? '');
    if (path === null) return c.json({ error: 'path must be a file inside the analysed project' }, 400);
    return c.json({ path, violations: violationsForFile(context, path) });
  });

  app.post('/', async (c) => {
    const parsed = parseBody(await c.req.json().catch(() => null));
    if (typeof parsed === 'string') return c.json({ error: parsed }, 400);
    if (deps.provider === null) return c.json({ error: 'no model is configured - choose one in the app or add an API key' }, 503);

    const context = deps.context();
    const path = normaliseRepoPath(context.root, parsed.path);
    if (path === null) return c.json({ error: 'path must be a file inside the analysed project' }, 400);
    const source = parsed.source ?? (await readFile(resolve(context.root, path), 'utf8').catch(() => null));
    if (source === null) return c.json({ error: `cannot read ${path}` }, 404);

    const violations = violationsForFile(context, path);
    const result = await reworkFile(deps.provider, {
      path,
      source,
      violations,
      helpers: await helpersForFile(context, path),
      rules: statedRules(context),
      ...(parsed.instruction === undefined ? {} : { instruction: parsed.instruction }),
    });
    if (!result.ok) {
      const status = result.error.reason === 'provider-error' ? 502 : 422;
      return c.json({ error: result.error.message, reason: result.error.reason }, status);
    }
    return c.json({ path, violations, ...result.value });
  });

  return app;
}
