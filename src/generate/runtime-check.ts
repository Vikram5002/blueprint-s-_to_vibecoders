/**
 * Metric D of docs/LOCAL-CODE-MODEL-PLAN.md §7: does the generated backend
 * actually start and answer its routes?
 *
 * `tsc` and Blueprint both passed a security middleware (`orderGuard`) that
 * then rejected every GET request the server received - a file can compile,
 * respect every import rule, and still be useless at runtime. This check
 * starts the built server (`dist/backend/src/index.js`, the `start` script
 * `assemble.ts` templates) on a free port, sends one GET to every backend
 * component's mount point (`/api/<slug>` and `/api/<slug>/`, both spellings
 * because a router with a single `'/'` route answers one and 404s the other
 * depending on how it was written), and records the status of each.
 *
 * What passes and what does not, deliberately: a route passes on ANY status
 * below 500. A 401 from an auth middleware, a 404 from a router that only
 * defines `/:id`, and a 400 from a validator are all evidence of a server
 * that is up and making decisions; only a crash (no answer at all) or a 5xx
 * (an unhandled throw inside the handler) counts as a failure. This is a
 * liveness check, not a functional test.
 *
 * The child process is always killed before this returns - as a process tree
 * on Windows, where `child.kill()` alone leaves the real `node` alive when
 * spawned through a shell, and with SIGTERM elsewhere.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { join, resolve } from 'node:path';
import type { Component, DomainName, ValidatedProjectSchema } from '../types/project-schema.js';
import { componentSlug, componentTargetPath } from './assemble.js';

export interface RouteResult {
  readonly path: string;
  /** HTTP status the server answered with, or null when no answer came back at all. */
  readonly status: number | null;
  readonly error?: string;
}

export interface RuntimeCheckResult {
  /** The server process came up and accepted a TCP connection within the timeout. */
  readonly started: boolean;
  readonly routes: readonly RouteResult[];
  /** `started` and every route passed (`status !== null && status < 500`). */
  readonly ok: boolean;
  /** Tail (<= 4000 chars) of the server's combined stdout+stderr - what it printed while starting and answering. */
  readonly serverOutput: string;
}

export interface RuntimeCheckOptions {
  /** How long to wait for the port to accept connections, and the ceiling on each request. Default 20s. */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Relative to `root`. Default is what `assemble.ts`'s package.json `start` script runs. */
  readonly entryPoint?: string;
}

export interface ComponentRouteResult {
  readonly component: Component;
  readonly domain: DomainName;
  readonly targetPath: string;
  /** The routes this component is judged on - its own two for a backend component, every route for a security one. */
  readonly routes: readonly RouteResult[];
  readonly passed: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_ENTRY_POINT = 'dist/backend/src/index.js';
const MAX_SERVER_OUTPUT_CHARS = 4_000;
const POLL_INTERVAL_MS = 200;

/** Both spellings of a backend component's mount point, in the order they are requested. */
export function routePathsFor(component: Component): readonly string[] {
  const slug = componentSlug(component.name);
  return [`/api/${slug}`, `/api/${slug}/`];
}

export function routePasses(route: RouteResult): boolean {
  return route.status !== null && route.status < 500;
}

export async function runRuntimeCheck(
  root: string,
  schema: ValidatedProjectSchema,
  options: RuntimeCheckOptions = {},
): Promise<RuntimeCheckResult> {
  // Resolved once: a relative root (scripts pass 'capture/code/work/<id>')
  // would otherwise be joined into the entry path AND used as the child's
  // cwd, so node resolved the entry relative to the root twice and the
  // server "never started". Found live on the first collection dry run.
  root = resolve(root);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Loopback only, to a child process this function itself spawned and kills
  // before returning - the same "own loopback server" reasoning
  // eslint.config.js gives server tests, not the outbound access rule 6
  // exists to prevent. Injectable for tests.
  // eslint-disable-next-line no-restricted-globals
  const doFetch = options.fetchImpl ?? fetch;
  const entryPoint = join(root, ...(options.entryPoint ?? DEFAULT_ENTRY_POINT).split('/'));
  const paths = schema.domains.backend.components.flatMap(routePathsFor);

  if (!(await exists(entryPoint))) {
    return { started: false, routes: paths.map((path) => ({ path, status: null, error: 'server not started' })), ok: false, serverOutput: `entry point not found: ${entryPoint}` };
  }

  const port = await freePort();
  let output = '';
  const child = spawn(process.execPath, [entryPoint], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.on('data', (chunk: Buffer) => (output = (output + chunk.toString()).slice(-MAX_SERVER_OUTPUT_CHARS)));
  child.stderr?.on('data', (chunk: Buffer) => (output = (output + chunk.toString()).slice(-MAX_SERVER_OUTPUT_CHARS)));
  const exited = new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
    child.on('error', (cause) => {
      output = (output + `\nspawn error: ${String(cause)}`).slice(-MAX_SERVER_OUTPUT_CHARS);
      resolve();
    });
  });

  try {
    const started = await waitForPort(port, timeoutMs, child);
    if (!started) {
      return { started: false, routes: paths.map((path) => ({ path, status: null, error: 'server not started' })), ok: false, serverOutput: output };
    }

    const routes: RouteResult[] = [];
    for (const path of paths) {
      routes.push(await requestRoute(doFetch, `http://127.0.0.1:${port}${path}`, path, timeoutMs));
    }
    // A server that died mid-check (an unhandled rejection on the last
    // request, say) is not "up"; the routes it answered before dying still
    // stand as recorded, the verdict does not.
    const stayedUp = child.exitCode === null && child.signalCode === null;
    return { started: true, routes, ok: stayedUp && routes.every(routePasses), serverOutput: output };
  } finally {
    await killTree(child, exited);
  }
}

/**
 * Maps the whole-server result back onto components: a backend component
 * is judged on its own two routes, a security component (mounted as global
 * middleware, so it runs on every request) on all of them. Frontend and
 * database components have no route of their own and are not listed. This
 * is what "D passes on every accepted component" (the ship bar) means.
 */
export function routeResultsFor(schema: ValidatedProjectSchema, result: RuntimeCheckResult): readonly ComponentRouteResult[] {
  const byPath = new Map(result.routes.map((route) => [route.path, route] as const));
  const judge = (component: Component, domain: DomainName, routes: readonly RouteResult[]): ComponentRouteResult => ({
    component,
    domain,
    targetPath: componentTargetPath(domain, component),
    routes,
    passed: result.started && routes.every(routePasses),
  });

  const backend = schema.domains.backend.components.map((component) =>
    judge(
      component,
      'backend',
      routePathsFor(component).map((path) => byPath.get(path) ?? { path, status: null, error: 'not requested' }),
    ),
  );
  const security = schema.domains.security.components.map((component) => judge(component, 'security', result.routes));
  return [...security, ...backend];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : null;
      server.close(() => (port === null ? reject(new Error('could not allocate a port')) : resolve(port)));
    });
  });
}

function tryConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForPort(port: number, timeoutMs: number, child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    if (await tryConnect(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return false;
}

async function requestRoute(doFetch: typeof fetch, url: string, path: string, timeoutMs: number): Promise<RouteResult> {
  try {
    const response = await doFetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    // Drain so the socket is released before the next request and before the kill.
    await response.arrayBuffer().catch(() => undefined);
    return { path, status: response.status };
  } catch (cause) {
    return { path, status: null, error: String(cause) };
  }
}

/**
 * Never leaves the server running. On Windows `taskkill /T /F` takes the
 * whole tree; elsewhere SIGTERM then, if the process ignores it, SIGKILL.
 */
async function killTree(child: ChildProcess, exited: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('exit', () => resolve());
      killer.on('error', () => {
        child.kill();
        resolve();
      });
    });
  } else {
    child.kill('SIGTERM');
  }
  const grace = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3_000).unref());
  if ((await Promise.race([exited, grace])) === 'timeout') {
    child.kill('SIGKILL');
    await exited;
  }
}
