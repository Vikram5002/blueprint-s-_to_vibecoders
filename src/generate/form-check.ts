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
  /** Fields the page sends as a list (`.split(...)`, `.map(...)`, `[...]` or an array state) - tried as a list. */
  readonly arrays?: readonly string[];
}

/**
 * Which of `fields` the page builds as a list. Found live (2026-10-24, cafe
 * app in a browser): the page sent `orderItems: items.split(',')`, the table
 * could not bind an array and the API crashed, while the check had sent text.
 */
function arrayFields(fields: readonly string[], options: string, source: string): string[] {
  const esc = (f: string): string => f.replace(/\$/g, '\\$');
  return fields.filter((field) => {
    const f = esc(field);
    if (new RegExp(String.raw`\b${f}\s*:\s*(?:\[|[^,}\n]*\.(?:split|map|filter)\s*\()`).test(options)) return true;
    if (new RegExp(String.raw`\[\s*${f}\s*,\s*\w+\s*\]\s*=\s*useState\s*(?:<[^>]*\[\]\s*>)?\s*\(\s*\[`).test(source)) return true;
    return new RegExp(String.raw`useState\s*(?:<[^>]*>)?\s*\(\s*\{[^}]*\b${f}\s*:\s*\[`).test(source);
  });
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

/** Every `fetch` of the app's own API in a page: data-sending calls with their fields, and reads (GET, no fields). */
/**
 * The code a page runs: block comments and whole-line comments removed. Found live (2026-10-28,
 * hotel app): a repair commented out `fetch('/api/rooms')` and showed hardcoded rooms, and the
 * check still read the commented call - so a page faking its data was never caught.
 */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

export function pageCalls(page: string, code: string): PageCall[] {
  const calls: PageCall[] = [];
  const source = withoutComments(code);
  for (const match of source.matchAll(/\bfetch\s*\(/g)) {
    const args = balanced(source, (match.index ?? 0) + match[0].length - 1);
    if (args === null) continue;
    const url = /^\s*(["'`])([^"'`]*)\1/.exec(args);
    if (url === null) continue;
    const path = (url[2] ?? '').replace(/\$\{[^}]*\}/g, '1').split('?')[0] ?? '';
    if (!path.startsWith('/api/')) continue;
    // After the address: a `${id}` inside it is not the options object.
    const optionsAt = args.indexOf('{', url[0].length);
    const options = optionsAt === -1 ? '' : (balanced(args, optionsAt) ?? '');
    const method = /method\s*:\s*["'`](\w+)["'`]/.exec(options)?.[1]?.toUpperCase() ?? 'GET';
    if (method === 'GET') calls.push({ page, method, path, fields: [] });
    else if (['POST', 'PUT', 'PATCH'].includes(method)) {
      const fields = bodyFields(options, source);
      const arrays = fields === null ? [] : arrayFields(fields, options, source);
      calls.push({ page, method, path, fields, ...(arrays.length > 0 ? { arrays } : {}) });
    }
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
  routes.map((r) => `${r.method} ${r.path}${r.fields.length > 0 ? ` (reads ${r.fields.join(', ')})` : ''}`).join('; ') || 'no routes';

/**
 * A page that calls no API at all in an app that has API routes. Plans often omit
 * the frontend -> backend link (the finance plan did), so the routes decide, not dependsOn.
 * Found live (2026-10-23, finance app): five 10-line pages with a title and a
 * sentence built cleanly, passed every check, and the form check reported 0
 * calls - so 0 problems - while no one could enter or see any data.
 */
export function unusedPages(schema: ValidatedProjectSchema, files: readonly GeneratedFile[], routes: readonly ApiRoute[]): FormProblem[] {
  if (routes.length === 0) return [];
  const message = unusedPageMessage(routes);
  return schema.domains.frontend.components.flatMap((component) => {
    if (isInformationPage(component.name) || !apiHasDataFor(component.name, routes)) return [];
    const page = componentTargetPath('frontend', component);
    const source = files.find((f) => f.path === page)?.contents;
    if (source === undefined || /\bfetch\s*\(/.test(withoutComments(source))) return [];
    return [{
      page,
      call: 'none',
      message,
    }];
  });
}

// Pages whose name says they only inform. Found live (2026-10-28, hotel app): "About Us"
// and "Homepage" showed text, which is all they are for, and were reported as broken forms.
const INFORMATION_WORDS = new Set(['about', 'home', 'homepage', 'landing', 'welcome', 'faq', 'faqs', 'terms', 'privacy', 'policy', 'help', 'story', 'mission', 'team', 'info', 'information', 'gallery']);

/** A page named only to inform (About Us, Homepage, FAQ) - it need not call the API. */
export function isInformationPage(name: string): boolean {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).some((w) => INFORMATION_WORDS.has(w));
}

const pathWords = (path: string): Set<string> =>
  new Set(path.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter((w) => w !== '' && w !== 'api').map((w) => w.replace(/s$/, '')));

const GENERIC_PAGE_WORDS = new Set(['page', 'form', 'list', 'view', 'screen', 'panel', 'dashboard', 'manager', 'management']);

/**
 * Whether any route's path names what the page is about, or the page's name is all generic words.
 * A Contact page in an app with no contact route has nothing to call (hotel app, 2026-10-28);
 * a "Reporting Dashboard" beside /reporting-service/reports does (finance app, 2026-10-23).
 */
function apiHasDataFor(name: string, routes: readonly ApiRoute[]): boolean {
  const words = [...pathWords(name)].filter((w) => !GENERIC_PAGE_WORDS.has(w));
  if (words.length === 0) return true;
  const offered = new Set(routes.flatMap((r) => [...pathWords(r.path)]));
  return words.some((w) => offered.has(w));
}

/** The offered route with the same method sharing the most words with `path` - a hint, never a match. */
export function closestRoute(method: string, path: string, routes: readonly ApiRoute[]): ApiRoute | undefined {
  const wanted = pathWords(path);
  let best: { route: ApiRoute; score: number } | undefined;
  for (const route of routes) {
    if (route.method !== method) continue;
    const score = [...pathWords(route.path.split('/').slice(3).join('/'))].filter((w) => wanted.has(w)).length;
    if (score > 0 && (best === undefined || score > best.score)) best = { route, score };
  }
  return best?.route;
}

/** The unused-page problem in words; exported so training data uses exactly the checker's text. */
export function unusedPageMessage(routes: readonly ApiRoute[]): string {
  const offered = routes.map((r) => `${r.method} ${r.path}${r.fields.length > 0 ? ` (reads ${r.fields.join(', ')})` : ''}`).join('; ');
  return (
    `the page calls no API route, so nothing can be entered or shown. The API offers: ${offered}. ` +
    `Load and show the records this page is for (GET), and give a form with a labelled input for every field ` +
    `the matching POST route reads, sending them to that route with the same field names.`
  );
}

/** What can be decided without running anything: a route to call, and every field it reads. */
export function staticProblems(calls: readonly PageCall[], routes: readonly ApiRoute[]): FormProblem[] {
  const problems: FormProblem[] = [];
  for (const call of calls) {
    const label = `${call.method} ${call.path}`;
    const route = matchRoute(call, routes);
    if (route === undefined) {
      // Found live (2026-10-28, hotel app): GET /api/room-types where /room-details existed, and
      // POST /api/contact with no contact route at all - the fix needs a nearest route or permission to drop the call.
      const near = closestRoute(call.method, call.path, routes);
      const hint = near === undefined
        ? ` No route fits, so remove this call and keep what the page shows as plain content.`
        : ` The closest is ${near.method} ${near.path}${near.fields.length > 0 ? ` (reads ${near.fields.join(', ')})` : ''}; use it if it is for this page's data, otherwise remove the call.`;
      problems.push({ page: call.page, call: label, message: `the page sends ${label}, but the API has no such route.${hint} The API offers: ${describeRoutes(routes)}.` });
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

/**
 * Fields a page reads from list items: `x.prop` where `x` is the item of a
 * `.map(x => ...)`. Found live (2026-10-20, library app): a queue page showed
 * empty fields and "Invalid Date" because it read names the API never
 * returned - nothing compared what a page shows with what the API sends.
 */
export function shownItemFields(source: string): string[] {
  // Only loops over a plain variable (`orders.map(o => ...)`), never a nested list (`o.items.map(...)`).
  const items = new Set([...source.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*\??\.map\(\s*\(?\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1] ?? ''));
  const NOT_FIELDS = new Set(['length', 'map', 'filter', 'toFixed', 'toString', 'toLocaleString', 'toLocaleDateString', 'trim', 'join', 'slice', 'includes', 'toUpperCase', 'toLowerCase']);
  const fields = new Set<string>();
  for (const item of items) {
    if (item === '') continue;
    const name = item.replace(/\$/g, '\\$');
    for (const m of source.matchAll(new RegExp(String.raw`(?<![\w$])${name}\??\.([A-Za-z_$][\w$]*)`, 'g'))) {
      const field = m[1] ?? '';
      if (!NOT_FIELDS.has(field)) fields.add(field);
    }
  }
  return [...fields];
}

const NUMBER_WORDS = new Set(['id', 'count', 'quantity', 'qty', 'size', 'copies', 'number', 'amount', 'price', 'total', 'age', 'rating', 'seats', 'capacity', 'year', 'balance', 'score']);
const BOOLEAN_WORDS = new Set(['is', 'has', 'active', 'enabled', 'done', 'completed', 'available', 'paid']);
const DATE_WORDS = new Set(['date', 'at', 'day', 'dob', 'deadline']);

/**
 * A plain test value from a field's name alone, by whole words: `party_size`
 * and `bookId` are numbers, `createdAt` a date. Whole words, because a
 * substring match sent 1 for `message` (it contains "age") and was refused.
 */
export function sampleValue(field: string): string | number | boolean {
  const words = field.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter((w) => w !== '');
  const has = (set: Set<string>): boolean => words.some((w) => set.has(w));
  if (has(NUMBER_WORDS)) return 1;
  if (has(BOOLEAN_WORDS)) return true;
  if (has(DATE_WORDS)) return new Date().toISOString().slice(0, 10);
  if (words.includes('time')) return '12:30';
  if (words.includes('email')) return 'test@example.com';
  if (words.includes('phone') || words.includes('mobile')) return '9876543210';
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
  const problems = [...unusedPages(schema, files, routes), ...staticProblems(calls, routes)];
  // Each distinct call once: a page often loads the same list in several places.
  const live = [...new Map(calls
    .filter((call) => !problems.some((p) => p.page === call.page && p.call === `${call.method} ${call.path}`) && call.fields !== null)
    .map((call) => [`${call.page} ${call.method} ${call.path}`, call] as const)).values()];
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
    const ids = await createLinkedRecords(doFetch, `http://127.0.0.1:${server.port}`, live, routes, timeoutMs);
    // Writes first, so a list read afterwards has a record to compare.
    live.sort((a, b) => Number(a.method === 'GET') - Number(b.method === 'GET'));
    for (const call of live) {
      // Shown fields are compared only for a page that loads one list - with two, which record a field belongs to is unknown.
      const reads = new Set(calls.filter((c) => c.page === call.page && c.method === 'GET').map((c) => c.path.replace(/\/1(?=\/|$)/g, '')));
      const source = reads.size === 1 ? files.find((f) => f.path === call.page)?.contents : undefined;
      const problem = await tryCall(doFetch, `http://127.0.0.1:${server.port}`, call, routes, timeoutMs, server.output, source, ids);
      if (problem === null) passed += 1;
      else problems.push(problem);
    }
  } finally {
    await server.stop();
  }
  return { calls, routes, problems, passed };
}

/** `customerId` / `room_id` -> `customer` / `room`; null for anything else. */
export function linkedRecord(field: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9]*?)(?:Id|ID|_id|_ID)$/.exec(field);
  return m?.[1] !== undefined && m[1] !== '' ? m[1].replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ').pop() ?? null : null;
}

function idFrom(record: unknown, name: string): string | number | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const r = record as Record<string, unknown>;
  for (const key of ['id', `${name}Id`, `${name}_id`]) {
    const v = r[key];
    if (typeof v === 'number' || typeof v === 'string') return v;
  }
  for (const v of Object.values(r)) {
    const nested = typeof v === 'object' && v !== null && !Array.isArray(v) ? idFrom(v, name) : undefined;
    if (nested !== undefined) return nested;
  }
  return undefined;
}

const bodyFor = (fields: readonly string[], ids: ReadonlyMap<string, string | number>, arrays?: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(fields.map((field) => {
    if (arrays?.includes(field) === true) return [field, [`Check ${field}`]];
    const linked = linkedRecord(field);
    return [field, (linked !== null ? ids.get(linked) : undefined) ?? sampleValue(field)];
  }));

/**
 * Creates one record for every record a call links to (`customerId` -> a POST to a customer route) and
 * returns their real ids. Found live (2026-10-28, hotel app): a booking was sent `customerId: 1` into an
 * empty database, the foreign key refused it, and the generated route was blamed for the check's test data.
 */
async function createLinkedRecords(
  doFetch: typeof fetch,
  origin: string,
  calls: readonly PageCall[],
  routes: readonly ApiRoute[],
  timeoutMs: number,
): Promise<Map<string, string | number>> {
  const ids = new Map<string, string | number>();
  const tried = new Set<string>();
  const create = async (name: string, depth: number): Promise<void> => {
    if (tried.has(name) || depth > 3) return;
    tried.add(name);
    const route = routes.find((r) => r.method === 'POST' && !r.path.includes(':') && pathWords(r.path.split('/').pop() ?? '').has(name));
    if (route === undefined) return;
    for (const field of route.fields) {
      const linked = linkedRecord(field);
      if (linked !== null && linked !== name) await create(linked, depth + 1);
    }
    try {
      const response = await doFetch(`${origin}${route.path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyFor(route.fields, ids)), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return;
      let id = idFrom(JSON.parse(await response.text()) as unknown, name);
      if (id === undefined && routes.some((r) => r.method === 'GET' && r.path === route.path)) {
        const list = JSON.parse(await (await doFetch(`${origin}${route.path}`, { signal: AbortSignal.timeout(timeoutMs) })).text()) as unknown;
        id = Array.isArray(list) ? idFrom(list[list.length - 1], name) : undefined;
      }
      if (id !== undefined) ids.set(name, id);
    } catch {
      // No id to offer: the call is tried with the plain value, as before.
    }
  };
  for (const call of calls) for (const field of call.fields ?? []) {
    const linked = linkedRecord(field);
    if (linked !== null) await create(linked, 0);
  }
  return ids;
}

async function tryCall(
  doFetch: typeof fetch,
  origin: string,
  call: PageCall,
  routes: readonly ApiRoute[],
  timeoutMs: number,
  serverOutput: () => string,
  pageSource?: string,
  ids: ReadonlyMap<string, string | number> = new Map(),
): Promise<FormProblem | null> {
  const label = `${call.method} ${call.path}`;
  const body = bodyFor(call.fields ?? [], ids, call.arrays);
  try {
    const before = serverOutput().length;
    const response = await doFetch(
      `${origin}${call.path}`,
      call.method === 'GET'
        ? { signal: AbortSignal.timeout(timeoutMs) }
        : { method: call.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) },
    );
    const full = await response.text();
    const text = full.slice(0, 300);
    // A 5xx is the API crashing on a request the page really makes: the route file is at fault, not the page.
    const route = matchRoute(call, routes);
    if (response.status >= 500 && route !== undefined) {
      const logged = serverOutput().slice(before).trim().slice(-600);
      return {
        page: route.file,
        call: label,
        message: `${label}${call.method === 'GET' ? '' : ` with ${JSON.stringify(body)}`} crashed the API: HTTP ${response.status}. Server output: ${logged || text}`,
      };
    }
    // A read only has to answer: a 404 for /items/1 is a normal "no such item". When it returns records,
    // the fields the page shows for each item must be fields the records have.
    if (call.method === 'GET') {
      if (response.status >= 400 || pageSource === undefined) return null;
      let records: unknown;
      try { records = JSON.parse(full); } catch { return null; }
      const first = Array.isArray(records) ? records.find((r) => typeof r === 'object' && r !== null) : undefined;
      if (first === undefined) return null;
      const keys = new Set(Object.keys(first as object));
      const missing = shownItemFields(pageSource).filter((field) => !keys.has(field));
      return missing.length === 0
        ? null
        : { page: call.page, call: label, message: `the page shows ${missing.join(', ')} for each item of ${label}, but its records have ${[...keys].join(', ')} - those fields show as empty. Use the API's field names.` };
    }
    // 401/403 is the API deciding about who is asking - a login refusing test credentials (found live on the
    // finance app's client portal) or a route that needs a session. Correct behaviour, not a broken form.
    if (response.status === 401 || response.status === 403) return null;
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

/**
 * Puts back a missing service name in a page's API address, with no model: `/api/rooms` when the
 * only route it can mean is `/api/api-server/rooms`. Found live (2026-10-28, hotel app): the repair
 * coder was told the exact route three rounds in a row and never wrote it. Only rewrites a call that
 * matches no route and becomes a route of the same method under exactly one service.
 */
export function fixMissingMounts(files: readonly GeneratedFile[], routes: readonly ApiRoute[]): { files: GeneratedFile[]; fixed: string[] } {
  const slugs = [...new Set(routes.map((r) => r.path.split('/')[2] ?? ''))].filter((s) => s !== '');
  const fixed: string[] = [];
  const out = files.map((file) => {
    if (!file.path.startsWith('frontend/')) return file;
    let contents = file.contents;
    for (const call of pageCalls(file.path, file.contents)) {
      const segment = call.path.split('/')[2] ?? '';
      if (segment === '' || slugs.includes(segment) || matchRoute(call, routes) !== undefined) continue;
      const owners = slugs.filter((slug) => matchRoute({ ...call, path: `/api/${slug}${call.path.slice(4)}` }, routes) !== undefined);
      if (owners.length !== 1) continue;
      const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const next = contents.replace(new RegExp(`(["'\`])/api/${escaped}(?=[/"'\`?])`, 'g'), `$1/api/${owners[0]}/${segment}`);
      if (next !== contents) {
        contents = next;
        fixed.push(`${file.path}: /api/${segment} -> /api/${owners[0]}/${segment}`);
      }
    }
    return contents === file.contents ? file : { ...file, contents };
  });
  return { files: out, fixed };
}
