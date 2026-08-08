/**
 * Local HTTP server.
 *
 * Binds 127.0.0.1 only — never 0.0.0.0. This is a local-first tool reading a
 * user's private source code; the graph, the file paths and the source lines in
 * the evidence trail must not be reachable from the network.
 *
 * Port 0 asks the OS for a free port, so nothing is hard-coded and two runs can
 * coexist.
 */
import { readFile } from 'node:fs/promises';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import {
  buildEdgeResponse,
  buildGraphResponse,
  buildNodeResponse,
  buildSummaryResponse,
} from './api.js';
import type { ViewLevel } from '../graph/aggregate.js';
import type { AnalysisContext } from './context.js';

export const LOOPBACK_HOST = '127.0.0.1';

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Built UI assets. Same relative position from src/server/ and dist/server/.
 * Kept as a URL so relative resolution and the containment check below both
 * work on one comparable representation.
 */
const STATIC_ROOT = new URL('./static/', import.meta.url);

const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json; charset=utf-8'],
  ['.ico', 'image/x-icon'],
]);

export function createApp(context: AnalysisContext): Hono {
  const app = new Hono();

  app.get('/api/summary', (c) => c.json(buildSummaryResponse(context)));

  app.get('/api/graph', (c) => {
    const level: ViewLevel = c.req.query('level') === 'file' ? 'file' : 'directory';
    // Repeated ?expand= params, so several directories can be open at once.
    const expanded = c.req.queries('expand') ?? [];
    return c.json(buildGraphResponse(context, level, expanded));
  });

  app.get('/api/node/*', (c) => {
    const id = decodeIdFromPath(c.req.path, '/api/node/');
    const payload = buildNodeResponse(context, id);
    return payload === null ? c.json({ error: `unknown node: ${id}` }, 404) : c.json(payload);
  });

  app.get('/api/edge/*', (c) => {
    const id = decodeIdFromPath(c.req.path, '/api/edge/');
    const payload = buildEdgeResponse(context, id);
    return payload === null ? c.json({ error: `unknown edge: ${id}` }, 404) : c.json(payload);
  });

  app.get('*', async (c) => {
    const served = await serveStatic(c.req.path);
    if (served !== null) {
      return c.body(served.body, 200, { 'content-type': served.contentType });
    }
    return c.text(MISSING_UI_MESSAGE, 503, { 'content-type': 'text/plain; charset=utf-8' });
  });

  return app;
}

export async function startServer(context: AnalysisContext): Promise<RunningServer> {
  const app = createApp(context);

  const server: ServerType = await new Promise((resolve) => {
    const created = serve({ fetch: app.fetch, hostname: LOOPBACK_HOST, port: 0 }, () => resolve(created));
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://${LOOPBACK_HOST}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Node ids are repo-relative paths, so they arrive as the wildcard remainder. */
function decodeIdFromPath(path: string, prefix: string): string {
  const raw = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

interface StaticFile {
  /** Plain ArrayBuffer: a Node Buffer may be SharedArrayBuffer-backed, which the response body type rejects. */
  readonly body: ArrayBuffer;
  readonly contentType: string;
}

/**
 * Serves the built UI. Unknown paths fall back to index.html so client-side
 * routing works, but anything trying to climb out of the static root is
 * refused — a local server still should not hand out arbitrary files.
 */
async function serveStatic(requestPath: string): Promise<StaticFile | null> {
  const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const direct = await readStaticFile(relative);
  if (direct !== null) {
    return direct;
  }
  return readStaticFile('index.html');
}

async function readStaticFile(relativePath: string): Promise<StaticFile | null> {
  if (relativePath.includes('..') || relativePath.includes('\0')) {
    return null;
  }

  const target = new URL(relativePath, STATIC_ROOT);
  if (!target.href.startsWith(STATIC_ROOT.href)) {
    return null;
  }

  const raw = await readFile(target).catch(() => null);
  if (raw === null) {
    return null;
  }

  const extension = relativePath.slice(relativePath.lastIndexOf('.'));
  return {
    body: Uint8Array.from(raw).buffer,
    contentType: CONTENT_TYPES.get(extension) ?? 'application/octet-stream',
  };
}

const MISSING_UI_MESSAGE = [
  'The UI has not been built.',
  '',
  'Run `npm run build` to compile it, then start again.',
  'The JSON API is available regardless: /api/summary, /api/graph, /api/node/<path>, /api/edge/<id>.',
].join('\n');
