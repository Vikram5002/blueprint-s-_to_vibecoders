/**
 * Refuses any request that did not come from this machine's own pages.
 *
 * Binding to 127.0.0.1 keeps other machines out, but not other websites: a
 * page open in the user's browser can still send requests to a loopback
 * port. A cross-site POST with a `text/plain` body needs no CORS preflight,
 * and Hono's `c.req.json()` parses it anyway - enough to start an import job
 * that clones a repository and runs its install scripts. DNS rebinding goes
 * further and lets a page read the GET routes too.
 *
 * Two checks close both holes:
 * - the Host the request was addressed to must be a loopback name, which a
 *   rebound domain never is;
 * - an Origin, when the browser sends one (it always does for a cross-site
 *   POST), must also be a loopback page.
 *
 * Any loopback port is accepted, so the Vite dev server can still proxy to
 * the API; the threat here is other websites, not other local processes.
 */
import type { MiddlewareHandler } from 'hono';

const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isLoopback(hostname: string): boolean {
  return LOOPBACK_NAMES.has(hostname.toLowerCase());
}

/** Hostname of an Origin header, or null when it is not a valid http(s) origin (including the literal `null`). */
function originHostname(origin: string): string | null {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : null;
  } catch {
    return null;
  }
}

export function localOriginOnly(): MiddlewareHandler {
  return async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (!isLoopback(host)) {
      return c.json({ error: `refused: requests must be addressed to this machine, not ${host}` }, 403);
    }
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      const originHost = originHostname(origin);
      if (originHost === null || !isLoopback(originHost)) {
        return c.json({ error: 'refused: cross-site request' }, 403);
      }
    }
    await next();
    return undefined;
  };
}
