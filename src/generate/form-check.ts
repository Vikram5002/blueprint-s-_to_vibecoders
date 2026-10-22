/**
 * The form check: does what a generated page sends actually work against
 * the generated API?
 *
 * Both files can compile, pass every Blueprint rule and answer the liveness
 * check while the page's Reserve button still posts `{ bookId }` to
 * `/api/catalog-api/reserve` and the API only offers `POST /reservations`
 * reading `book_id` and `user_id` (found live, 2026-10-22, library app).
 * Nothing measured that until now.
 *
 * Deterministic throughout - no model reads code or invents values here:
 *  1. every page `fetch(url, { method: 'POST'|'PUT'|'PATCH', body: JSON.stringify(...) })`
 *     is read for its address and the field names it sends;
 *  2. every backend router is read for the routes it offers and the
 *     `req.body` fields each handler reads;
 *  3. statically, the page's call must match a route and send every field
 *     that route reads;
 *  4. live, the built server is started, the call is sent with plain test
 *     values chosen from each field's name, and for a POST the collection is
 *     read back to see that the text values were stored.
 * A problem is reported against the PAGE file: the API is the contract the
 * page was given (component-codegen.ts lists the endpoints), and the API's
 * own failures (5xx) are already the liveness check's.
 */
import { join } from 'node:path';
import type { ValidatedProjectSchema } from '../types/project-schema.js';
import { componentSlug, componentTargetPath, type GeneratedFile } from './assemble.js';
import { startBuiltServer } from './runtime-check.js';

export interface PageCall {
  readonly page: string;
  readonly method: string;
  /** The address as written, `${...}` parts replaced by `1`. */
  readonly path: string;
  /** Field names the body sends; null when the body could not be read statically. */
  readonly fields: readonly string[] | null;
}

export interface ApiRoute {
  readonly file: string;
  readonly method: string;
  /** Full path, mount point included: `/api/<slug>/<route>`. */
  readonly path: string;
  /** `req.body` fields the handler reads. */
  readonly fields: readonly string[];
}

export interface FormProblem {
  readonly page: string;
  readonly call: string;
  readonly message: string;
}

export interface FormCheckResult {
  readonly calls: readonly PageCall[];
  readonly routes: readonly ApiRoute[];
  readonly problems: readonly FormProblem[];
  /** Calls that were sent to the running server and passed. */
  readonly passed: number;
}

// ---- reading code ----------------------------------------------------------

/** The text between the bracket at `open` and its match, or null. Strings are skipped so brackets inside them do not count. */
function balanced(source: string, open: number): string | null {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i] ?? '';
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (pairs[ch] !== undefined) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/** Top-level comma-separated parts of an object literal's inside. */
function topLevelParts(inside: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inside.length; i++) {
    const ch = inside[i] ?? '';
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(inside.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inside.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** Keys of an object literal's inside; `...name` spreads that state object's keys. Null when a key cannot be known. */
function objectKeys(inside: string, source: string): string[] | null {
  const keys: string[] = [];
  for (const part of topLevelParts(inside)) {
    if (part.startsWith('...')) {
      const spread = stateObjectKeys(part.slice(3).trim(), source);
      if (spread === null) return null;
      keys.push(...spread);
      continue;
    }
    const key = /^["']?([A-Za-z_$][\w$]*)["']?\s*(?::|$)/.exec(part)?.[1];
    if (key === undefined) return null;
    keys.push(key);
  }
  return keys;
}

/** Keys of `const [name, setName] = useState({ ... })` (any type argument), or null. */
function stateObjectKeys(name: string, source: string): string[] | null {
  const match = new RegExp(`\\[\\s*${name}\\s*,\\s*\\w+\\s*\\]\\s*=\\s*useState\\s*(?:<[^>]*>)?\\s*\\(\\s*\\{`).exec(source);
  if (match === null) return null;
  const inside = balanced(source, match.index + match[0].length - 1);
  return inside === null ? null : objectKeys(inside, source);
}

function bodyFields(options: string, source: string): string[] | null {
  const at = options.search(/body\s*:\s*JSON\.stringify\s*\(/);
  if (at === -1) return null;
  const open = options.indexOf('(', at);
  const expression = balanced(options, open)?.trim();
  if (expression === undefined) return null;
  if (expression.startsWith('{')) {
    const inside = balanced(expression, 0);
    return inside === null ? null : objectKeys(inside, source);
  }
  return /^[A-Za-z_$][\w$]*$/.test(expression) ? stateObjectKeys(expression, source) : null;
}

/** Every data-sending `fetch` in a page. */
export function pageCalls(page: string, source: string): PageCall[] {
  const calls: PageCall[] = [];
  for (const match of source.matchAll(/\bfetch\s*\(/g)) {
    const args = balanced(source, (match.index ?? 0) + match[0].length - 1);
    if (args === null) continue;
    const url = /^\s*(["'`])([^"'`]*)\1/.exec(args);
    // After the address: a `${id}` inside it is not the options object.
    const optionsAt = url === null ? -1 : args.indexOf('{', url[0].length);
    if (url === null || optionsAt === -1) continue;
    const options = balanced(args, optionsAt) ?? '';
    const method = /method\s*:\s*["'`](\w+)["'`]/.exec(options)?.[1]?.toUpperCase();
    if (method === undefined || !['POST', 'PUT', 'PATCH'].includes(method)) continue;
    const path = (url[2] ?? '').replace(/\$\{[^}]*\}/g, '1').split('?')[0] ?? '';
    calls.push({ page, method, path, fields: bodyFields(options, source) });
  }
  return calls;
}

/** Routes a backend router file offers, mounted at `/api/<slug>`, with the body fields each handler reads. */
export function apiRoutes(file: string, slug: string, source: string): ApiRoute[] {
  const starts = [...source.matchAll(/\brouter\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(["'`])([^"'`]*)\2/g)];
  return starts.map((match, index) => {
    const handler = source.slice(match.index ?? 0, starts[index + 1]?.index ?? source.length);
    const fields = new Set<string>();
    for (const destructure of handler.matchAll(/const\s*\{([^}]*)\}\s*=\s*req\.body/g)) {
      for (const part of (destructure[1] ?? '').split(',')) {
        const name = part.trim().split(/[:=\s]/)[0];
        if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) fields.add(name);
      }
    }
    for (const read of handler.matchAll(/req\.body\.([A-Za-z_$][\w$]*)/g)) fields.add(read[1] ?? '');
    const route = match[3] ?? '/';
    const path = `/api/${slug}${route === '/' ? '' : route.startsWith('/') ? route : `/${route}`}`;
    return { file, method: (match[1] ?? 'get').toUpperCase(), path, fields: [...fields].filter((f) => f !== '') };
  });
}

/** Every page call and API route in a generated project, by the paths assemble.ts gives components. */
export function readContracts(schema: ValidatedProjectSchema, files: readonly GeneratedFile[]): { calls: PageCall[]; routes: ApiRoute[] } {
  const source = (path: string): string | undefined => files.find((f) => f.path === path)?.contents;
  const calls = schema.domains.frontend.components.flatMap((component) => {
    const path = componentTargetPath('frontend', component);
    const text = source(path);
    return text === undefined ? [] : pageCalls(path, text);
  });
  const routes = schema.domains.backend.components.flatMap((component) => {
    const path = componentTargetPath('backend', component);
    const text = source(path);
    return text === undefined ? [] : apiRoutes(path, componentSlug(component.name), text);
  });
  return { calls, routes };
}

// ---- checking --------------------------------------------------------------

const pathPattern = (path: string): RegExp =>
  new RegExp(`^${path.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\:[A-Za-z_]\w*|:[A-Za-z_]\w*/g, '[^/]+')}/?$`);

export function matchRoute(call: PageCall, routes: readonly ApiRoute[]): ApiRoute | undefined {
  return routes.find((route) => route.method === call.method && pathPattern(route.path).test(call.path));
}

const describeRoutes = (routes: readonly ApiRoute[]): string =>
  routes
    .filter((r) => r.method !== 'GET' && r.method !== 'DELETE')
    .map((r) => `${r.method} ${r.path}${r.fields.length > 0 ? ` (reads ${r.fields.join(', ')})` : ''}`)
    .join('; ') || 'no routes that take data';

/** What can be decided without running anything: a route to call, and every field it reads. */
export function staticProblems(calls: readonly PageCall[], routes: readonly ApiRoute[]): FormProblem[] {
  const problems: FormProblem[] = [];
  for (const call of calls) {
    const label = `${call.method} ${call.path}`;
    const route = matchRoute(call, routes);
    if (route === undefined) {
      problems.push({ page: call.page, call: label, message: `the page sends ${label}, but the API has no such route. The API offers: ${describeRoutes(routes)}.` });
      continue;
    }
    if (call.fields === null) continue;
    const missing = route.fields.filter((field) => !call.fields?.includes(field));
    if (missing.length > 0) {
      problems.push({
        page: call.page,
        call: label,
        message: `${label} reads ${route.fields.join(', ')}, but the page sends ${call.fields.join(', ') || 'nothing'} - missing ${missing.join(', ')}. Send exactly the fields the route reads, with the same names.`,
      });
    }
  }
  return problems;
}

/** A plain test value from a field's name alone. */
export function sampleValue(field: string): string | number | boolean {
  const name = field.toLowerCase();
  if (/(^id$|_id$|id$|count|quantity|qty|size|copies|number|amount|price|total|age|rating|seats|capacity|year)/.test(name)) return 1;
  if (/^(is|has)[_A-Z]|active|enabled|done|completed|available$/.test(field)) return true;
  if (/date|_at$|at$|day/.test(name)) return new Date().toISOString().slice(0, 10);
  if (/time/.test(name)) return '12:30';
  if (/email/.test(name)) return 'test@example.com';
  if (/phone|mobile/.test(name)) return '9876543210';
  return `Check ${field}`;
}

export interface FormCheckOptions {
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly entryPoint?: string;
}

/** Reads every page call and route, then sends the matched calls to the running built server. */
export async function runFormCheck(
  root: string,
  schema: ValidatedProjectSchema,
  files: readonly GeneratedFile[],
  options: FormCheckOptions = {},
): Promise<FormCheckResult> {
  const { calls, routes } = readContracts(schema, files);
  const problems = staticProblems(calls, routes);
  const live = calls.filter((call) => !problems.some((p) => p.page === call.page && p.call === `${call.method} ${call.path}`) && call.fields !== null);
  if (live.length === 0) return { calls, routes, problems, passed: 0 };

  const timeoutMs = options.timeoutMs ?? 20_000;
  // Loopback only, to a child process this function starts and always stops (runtime-check.ts).
  // eslint-disable-next-line no-restricted-globals
  const doFetch = options.fetchImpl ?? fetch;
  const server = await startBuiltServer(root, join(root, ...(options.entryPoint ?? 'dist/backend/src/index.js').split('/')), timeoutMs);
  let passed = 0;
  try {
    if (!server.started) {
      return { calls, routes, problems: [...problems, ...live.map((c) => ({ page: c.page, call: `${c.method} ${c.path}`, message: 'the server did not start, so the call could not be tried' }))], passed };
    }
    for (const call of live) {
      const problem = await tryCall(doFetch, `http://127.0.0.1:${server.port}`, call, routes, timeoutMs);
      if (problem === null) passed += 1;
      else problems.push(problem);
    }
  } finally {
    await server.stop();
  }
  return { calls, routes, problems, passed };
}

async function tryCall(doFetch: typeof fetch, origin: string, call: PageCall, routes: readonly ApiRoute[], timeoutMs: number): Promise<FormProblem | null> {
  const label = `${call.method} ${call.path}`;
  const body = Object.fromEntries((call.fields ?? []).map((field) => [field, sampleValue(field)]));
  try {
    const response = await doFetch(`${origin}${call.path}`, { method: call.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const text = (await response.text()).slice(0, 300);
    if (response.status >= 400) {
      return { page: call.page, call: label, message: `${label} with ${JSON.stringify(body)} was refused: HTTP ${response.status} ${text}` };
    }
    if (call.method !== 'POST') return null;
    // Read the collection back: the stored record should carry the text the page sent.
    const listed = routes.find((r) => r.method === 'GET' && pathPattern(r.path).test(call.path));
    if (listed === undefined) return null;
    const list = await (await doFetch(`${origin}${call.path}`, { signal: AbortSignal.timeout(timeoutMs) })).text();
    const lost = Object.entries(body).filter(([, value]) => typeof value === 'string' && value.startsWith('Check ') && !list.includes(value));
    return lost.length === 0
      ? null
      : { page: call.page, call: label, message: `${label} answered ${response.status}, but reading the list back does not show ${lost.map(([f]) => f).join(', ')} - the value was not saved.` };
  } catch (cause) {
    return { page: call.page, call: label, message: `${label} got no answer: ${String(cause)}` };
  }
}
