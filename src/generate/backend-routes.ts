/**
 * The HTTP routes a generated backend file really defines, read from its
 * source, so the frontend is told exact method + path pairs instead of only
 * each router's mount point.
 *
 * With only `/api/tracking-api` to go on, a frontend page guessed its
 * sub-paths - it called `/api/tracking-api/visitors` and `/goals` while the
 * router defined `/track` and `/events`, and every call 404ed (found live,
 * 2026-09-27). Backend files are generated before frontend ones, so their
 * real routes are known by then.
 *
 * Text-based, like extractNamedExports: `router.<method>('<path>'` with a
 * literal path. A route built dynamically is not listed; if a file yields
 * none, the caller falls back to the mount point alone.
 */
const ROUTE_PATTERN = /\b(?:router|app)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]*)\2/g;

export interface BackendRoute {
  readonly method: string;
  readonly path: string;
}

export function extractRoutes(source: string): readonly BackendRoute[] {
  const routes: BackendRoute[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(ROUTE_PATTERN)) {
    const method = (match[1] ?? '').toUpperCase();
    const path = match[3] ?? '';
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method, path });
  }
  return routes;
}

/** "GET /api/x/events" for each route under `mountPath`; the bare mount path when none were found. */
export function endpointsFor(mountPath: string, source: string | undefined): readonly string[] {
  const routes = source === undefined ? [] : extractRoutes(source);
  if (routes.length === 0) return [mountPath];
  return routes.map((route) => `${route.method} ${route.path === '/' || route.path === '' ? `${mountPath}/` : `${mountPath}${route.path.startsWith('/') ? '' : '/'}${route.path}`}`);
}
