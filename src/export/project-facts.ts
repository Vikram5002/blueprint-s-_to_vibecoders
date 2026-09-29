/**
 * Facts about a generated project, read from its own files - the raw
 * material for the Student Project Pack (project-pack.ts).
 *
 * Deterministic and text-based, like backend-routes.ts: an endpoint is listed
 * only where a router is really mounted and really defines the route, and a
 * table only where a `CREATE TABLE` statement really creates it. Nothing here
 * is inferred or asked of a model, so every line of the documents built from
 * it can be traced to a file in the project.
 */
import { extractRoutes } from '../generate/backend-routes.js';
import type { ZipEntry } from './runnable-project.js';

export const BACKEND_ENTRY = 'backend/src/index.ts';

export interface Endpoint {
  readonly method: string;
  /** Full path as a client calls it, e.g. /api/orders-api/items. */
  readonly path: string;
  /** Project file that defines it. */
  readonly file: string;
}

export interface TableColumn {
  readonly name: string;
  readonly type: string;
  readonly primaryKey: boolean;
  readonly notNull: boolean;
}

export interface TableReference {
  readonly column: string;
  readonly table: string;
}

export interface Table {
  readonly name: string;
  readonly columns: readonly TableColumn[];
  readonly references: readonly TableReference[];
  readonly file: string;
}

/** `import { router as quizApi } from './routes/quiz-api'` -> quizApi -> backend/src/routes/quiz-api.ts */
function importedFiles(indexSource: string): Map<string, string> {
  const files = new Map<string, string>();
  const pattern = /import\s*\{\s*(\w+)(?:\s+as\s+(\w+))?\s*\}\s*from\s*['"]\.\/([^'"]+)['"]/g;
  for (const match of indexSource.matchAll(pattern)) {
    const local = match[2] ?? match[1] ?? '';
    const relative = (match[3] ?? '').replace(/\.(js|ts)$/, '');
    files.set(local, `backend/src/${relative}.ts`);
  }
  return files;
}

/** Every route of every router `backend/src/index.ts` mounts, with its full path. */
export function extractEndpoints(entries: readonly ZipEntry[]): readonly Endpoint[] {
  const byPath = new Map(entries.map((entry) => [entry.path, entry.contents]));
  const index = byPath.get(BACKEND_ENTRY);
  if (index === undefined) return [];
  const files = importedFiles(index);
  const endpoints: Endpoint[] = [];
  for (const mount of index.matchAll(/app\s*\.\s*use\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\s*\)/g)) {
    const mountPath = (mount[1] ?? '').replace(/\/+$/, '');
    const file = files.get(mount[2] ?? '');
    const source = file === undefined ? undefined : byPath.get(file);
    if (file === undefined || source === undefined) continue;
    for (const route of extractRoutes(source)) {
      const sub = route.path === '' || route.path === '/' ? '' : route.path.startsWith('/') ? route.path : `/${route.path}`;
      endpoints.push({ method: route.method, path: `${mountPath}${sub}` || '/', file });
    }
  }
  return endpoints;
}

/** The text between the parenthesis at `open` and its match, or null when unbalanced. */
function balancedBody(source: string, open: number): string | null {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return null;
}

/** Splits a column list on the commas that are not inside parentheses. */
function topLevelParts(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

const unquote = (name: string): string => name.replace(/^["'`[]|["'`\]]$/g, '');
const TABLE_CONSTRAINT = /^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i;

function parseTable(name: string, body: string, file: string): Table {
  const columns: TableColumn[] = [];
  const references: TableReference[] = [];
  const tablePrimaryKeys = new Set<string>();
  for (const part of topLevelParts(body)) {
    if (TABLE_CONSTRAINT.test(part)) {
      const primary = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(part);
      for (const column of primary?.[1]?.split(',') ?? []) tablePrimaryKeys.add(unquote(column.trim()));
      const foreign = /FOREIGN\s+KEY\s*\(\s*([^)\s,]+)\s*\)\s*REFERENCES\s+([\w"`]+)/i.exec(part);
      if (foreign !== null) references.push({ column: unquote(foreign[1] ?? ''), table: unquote(foreign[2] ?? '') });
      continue;
    }
    const [rawName = '', rawType = ''] = part.split(/\s+/);
    const column = unquote(rawName);
    const inline = /REFERENCES\s+([\w"`]+)/i.exec(part);
    if (inline !== null) references.push({ column, table: unquote(inline[1] ?? '') });
    columns.push({
      name: column,
      type: /^[A-Za-z]+$/.test(rawType) ? rawType.toUpperCase() : '',
      primaryKey: /PRIMARY\s+KEY/i.test(part),
      notNull: /NOT\s+NULL/i.test(part),
    });
  }
  return {
    name,
    columns: columns.map((column) => (tablePrimaryKeys.has(column.name) ? { ...column, primaryKey: true } : column)),
    references,
    file,
  };
}

/** Every table a `CREATE TABLE` statement creates, in any backend file. */
export function extractTables(entries: readonly ZipEntry[]): readonly Table[] {
  const tables: Table[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.path.startsWith('backend/') || !/\.(ts|js)$/.test(entry.path)) continue;
    for (const match of entry.contents.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"`[\]]+)\s*\(/gi)) {
      const name = unquote(match[1] ?? '');
      const body = balancedBody(entry.contents, (match.index ?? 0) + match[0].length - 1);
      if (body === null || seen.has(name)) continue;
      seen.add(name);
      tables.push(parseTable(name, body, entry.path));
    }
  }
  return tables;
}
