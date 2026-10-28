/**
 * Layer 3: turns individually-generated component files into one coherent,
 * installable project.
 *
 * `package.json`, `tsconfig.json`, and the entry points that wire every
 * generated file together are templated here, never LLM-generated — the one
 * place most likely to have cross-file wiring bugs is kept out of the
 * model's hands entirely, per the approved design.
 *
 * Milestone 1 shipped backend + security only; Milestone 2 adds database
 * (folded into backend/src/db, same "no runtime of its own" reasoning
 * security's folding already used) and frontend (React + Vite, its own
 * top-level folder, communicating with the backend over HTTP only - never a
 * local import, so it needs no folding). `packageJsonFile`/`tsconfigFile`
 * take an optional `AssemblyDomains` flag so a backend-only Milestone 1
 * project keeps generating the exact same, smaller manifest it always did -
 * calling either with no argument is unchanged from Milestone 1.
 */
import { componentSlug, type Component, type DomainName } from '../types/project-schema.js';

export interface AssemblyDomains {
  readonly database?: boolean;
  readonly frontend?: boolean;
}

export interface GeneratedFile {
  /** Repo-relative path, posix separators, relative to the project root. */
  readonly path: string;
  readonly contents: string;
}

/**
 * Fixed stack, locked per the approved design: Express + TypeScript for the
 * backend, CommonJS module output (not ESM) so relative imports need no
 * `.js` extension — one fewer thing a freshly generated file has to get
 * right. See docs/GENERATION.md for the full locked-stack table and its
 * revision history.
 *
 * Database was locked as "raw SQL over better-sqlite3" in Milestone 1's
 * proposal, then revised during Milestone 2: a real generation run on a
 * fresh machine (Node v24.11.0, no C++ build toolchain) hit
 * better-sqlite3's native-compilation requirement head-on - no prebuilt
 * binary existed for that Node version, and `node-gyp` failed outright with
 * no Visual Studio installation to fall back on. That is exactly the kind
 * of "arbitrary machine" this pipeline is meant to run on, so the database
 * layer moved to `node:sqlite` (Node's own built-in module, no npm
 * dependency and no native compilation at all) - see docs/GENERATION.md's
 * decision log for the full reasoning and the experimental-status tradeoff
 * this accepts.
 */
export function packageJsonFile(domains: AssemblyDomains = {}): GeneratedFile {
  const template = {
    name: 'generated-backend',
    private: true,
    version: '0.0.0',
    ...(domains.database ? { engines: { node: '>=22.5.0' } } : {}),
    scripts: {
      build: 'tsc',
      start: 'node dist/backend/src/index.js',
    },
    dependencies: {
      express: '^4.19.2',
      ...(domains.frontend ? { react: '^18.3.1', 'react-dom': '^18.3.1' } : {}),
    },
    devDependencies: {
      typescript: '^5.5.4',
      '@types/express': '^4.17.21',
      // node:sqlite's type declarations only exist in a recent @types/node -
      // bumped from Milestone 1's ^20.14.0 only when the database domain is
      // actually present, so a backend-only project's manifest is unchanged.
      '@types/node': domains.database ? '^22.10.0' : '^20.14.0',
      ...(domains.frontend ? { '@types/react': '^18.3.3', '@types/react-dom': '^18.3.0' } : {}),
    },
  };
  return { path: 'package.json', contents: `${JSON.stringify(template, null, 2)}\n` };
}

/**
 * Frontend build verification is typecheck-level only in Milestone 2: `tsc`
 * over `frontend/**\/*.tsx` with `jsx: "react-jsx"`, not an actual Vite
 * bundle. Real bundling (a `vite.config.ts`, dev server, browser round trip)
 * is out of scope here the same way actually starting the Express server
 * was out of scope for Milestone 1's "build" bar - both milestones verify
 * "this compiles", not "this runs a live process".
 */
export function tsconfigFile(domains: AssemblyDomains = {}): GeneratedFile {
  const tsconfig = {
    compilerOptions: {
      target: 'ES2020',
      module: 'commonjs',
      moduleResolution: 'node',
      outDir: 'dist',
      rootDir: '.',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      ...(domains.frontend ? { jsx: 'react-jsx' as const } : {}),
    },
    include: domains.frontend ? ['backend/**/*.ts', 'frontend/**/*.tsx'] : ['backend/**/*.ts'],
  };
  return { path: 'tsconfig.json', contents: `${JSON.stringify(tsconfig, null, 2)}\n` };
}

/**
 * File convention, per the locked stack: security folds into the backend's
 * own middleware folder (approved design §1: "security domain has no
 * runtime of its own ... compiles to Express middleware living inside
 * backend/"). Database folds into the backend the same way, for the same
 * reason - raw SQL over better-sqlite3 has no server of its own either, it
 * is a module the backend imports. Frontend gets its own top-level folder
 * because it does NOT fold in: a React app talks to the backend over HTTP,
 * never via a local import, so there is no coupling to hide by co-locating
 * it.
 */
export { componentSlug };

export function componentTargetPath(domain: DomainName, component: Component): string {
  const slug = componentSlug(component.name);
  if (domain === 'backend') return `backend/src/routes/${slug}.ts`;
  if (domain === 'security') return `backend/src/middleware/${slug}.ts`;
  if (domain === 'database') return `backend/src/db/${slug}.ts`;
  return `frontend/src/pages/${slug}.tsx`;
}

/**
 * Templated, not LLM-generated (see this file's own doc comment). Mounts
 * every security-domain component as global middleware (order: security
 * before routes, so an auth check the model actually wrote runs before any
 * route it protects) and every backend-domain component as a router at
 * `/api/<slug>`. Assumes each generated file's named export matches the
 * fixed contract stated in its own generation prompt - a named export
 * literally called `middleware` for security components, `router` for
 * backend ones (see `EXPORT_CONTRACT` in generate-project.ts) - if a
 * generated file's export shape does not match, `tsc` fails to build and
 * that failure is reported honestly rather than patched around here.
 */
export interface PublicRoute {
  readonly method: string;
  /** Full mounted path, e.g. /api/sign-up-api */
  readonly path: string;
}

/** A security component that checks who the caller is (vs rate limiting or input validation). */
export function isAuthenticationComponent(component: Component): boolean {
  return /\b(auth\w*|jwt|tokens?|login|session|guard)\b/i.test(`${component.name} ${component.purpose}`);
}

/**
 * A fixed file, never model-written: SQLite has no boolean type and node:sqlite refuses
 * `true`/`false` both at compile time and at run time. Found live (2026-10-28, hotel app):
 * `insertRoom(..., isAvailable: boolean)` failed the build three repair rounds in a row.
 * Imported first by the server, it lets every statement take a boolean and stores it as 1/0 -
 * for any table a model writes, not only the ones it was trained on.
 */
export function sqliteBooleansFile(): GeneratedFile {
  const lines = [
    '// Written by VibeCoder, not by a model. SQLite stores no booleans: true/false are sent as 1/0.',
    "import { StatementSync, type SQLInputValue, type SQLOutputValue, type StatementResultingChanges } from 'node:sqlite';",
    '',
    'type Value = SQLInputValue | boolean;',
    '',
    "declare module 'node:sqlite' {",
    '  interface StatementSync {',
    '    run(...anonymousParameters: Value[]): StatementResultingChanges;',
    '    run(namedParameters: Record<string, Value>, ...anonymousParameters: Value[]): StatementResultingChanges;',
    '    get(...anonymousParameters: Value[]): Record<string, SQLOutputValue> | undefined;',
    '    get(namedParameters: Record<string, Value>, ...anonymousParameters: Value[]): Record<string, SQLOutputValue> | undefined;',
    '    all(...anonymousParameters: Value[]): Record<string, SQLOutputValue>[];',
    '    all(namedParameters: Record<string, Value>, ...anonymousParameters: Value[]): Record<string, SQLOutputValue>[];',
    '  }',
    '}',
    '',
    'const plain = (value: unknown): unknown => {',
    "  if (typeof value === 'boolean') return value ? 1 : 0;",
    "  if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {",
    '    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, plain(v)]));',
    '  }',
    '  return value;',
    '};',
    '',
    "for (const method of ['run', 'get', 'all', 'iterate'] as const) {",
    '  const original = StatementSync.prototype[method] as (...args: unknown[]) => unknown;',
    '  Object.defineProperty(StatementSync.prototype, method, {',
    '    configurable: true,',
    '    writable: true,',
    '    value(this: StatementSync, ...args: unknown[]): unknown {',
    '      return original.apply(this, args.map(plain));',
    '    },',
    '  });',
    '}',
    '',
  ];
  return { path: 'backend/src/sqlite-booleans.ts', contents: lines.join('\n') };
}

export interface BackendEntryOptions {
  /** The project has a database: import sqlite-booleans before any table file runs. */
  readonly sqlite?: boolean;
}

export function backendEntryPointFile(
  backendComponents: readonly Component[],
  securityComponents: readonly Component[],
  publicRoutes: readonly PublicRoute[] = [],
  options: BackendEntryOptions = {},
): GeneratedFile {
  const lines: string[] = [
    ...(options.sqlite === true ? ["import './sqlite-booleans';"] : []),
    "import express from 'express';",
    "import { existsSync } from 'fs';",
    "import { join } from 'path';",
    '',
  ];

  for (const component of securityComponents) {
    const slug = componentSlug(component.name);
    lines.push(`import { middleware as ${importIdentifier(slug)} } from './middleware/${slug}';`);
  }
  for (const component of backendComponents) {
    const slug = componentSlug(component.name);
    lines.push(`import { router as ${importIdentifier(slug)} } from './routes/${slug}';`);
  }

  lines.push('', 'const app = express();', 'app.use(express.json());', '');

  // Public routes (a page form anyone may submit) skip the AUTHENTICATION
  // middleware only - rate limiting and input validation still run on them.
  const skipsPublic = publicRoutes.length > 0 && securityComponents.some(isAuthenticationComponent);
  if (skipsPublic) {
    lines.push(
      `const PUBLIC_ROUTES: ReadonlyArray<{ method: string; path: string }> = ${JSON.stringify(publicRoutes)};`,
      'function unlessPublic(guard: express.RequestHandler): express.RequestHandler {',
      '  return (req, res, next) =>',
      "    PUBLIC_ROUTES.some((route) => route.method === req.method && (req.path === route.path || req.path === `${route.path}/`)) ? next() : guard(req, res, next);",
      '}',
      '',
    );
  }
  for (const component of securityComponents) {
    const slug = componentSlug(component.name);
    const identifier = importIdentifier(slug);
    lines.push(`app.use(${skipsPublic && isAuthenticationComponent(component) ? `unlessPublic(${identifier})` : identifier});`);
  }
  lines.push('');
  for (const component of backendComponents) {
    const slug = componentSlug(component.name);
    lines.push(`app.use('/api/${slug}', ${importIdentifier(slug)});`);
  }

  // A database refusal is the request's fault, not a crash. Found live (2026-10-28, hotel app):
  // a booking for a customer that did not exist answered HTTP 500 with an HTML stack trace.
  lines.push(
    '',
    'app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {',
    "  const message = err instanceof Error ? err.message : String(err);",
    "  if (message.includes('FOREIGN KEY constraint failed')) return res.status(400).json({ error: 'a linked record does not exist' });",
    "  if (message.includes('UNIQUE constraint failed')) return res.status(409).json({ error: 'that record already exists' });",
    "  if (message.includes('NOT NULL constraint failed') || message.includes('CHECK constraint failed')) return res.status(400).json({ error: 'a required field is missing or invalid' });",
    '  return next(err);',
    '});',
  );

  lines.push(
    '',
    // `npm run serve` builds the site into dist/web; this file runs from dist/backend/src.
    "const site = join(__dirname, '..', '..', 'web');",
    'if (existsSync(site)) {',
    '  app.use(express.static(site));',
    '}',
    '',
    'const port = process.env.PORT ? Number(process.env.PORT) : 3000;',
    'app.listen(port, () => {',
    '  // eslint-disable-next-line no-console',
    "  console.log(`listening on ${port}`);",
    '});',
    '',
  );

  return { path: 'backend/src/index.ts', contents: lines.join('\n') };
}

function importIdentifier(slug: string): string {
  const camel = slug.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
  // "2FA Router" -> 2FaRouter is not a valid identifier, and the whole
  // generated project failed to compile on it; a leading underscore makes it
  // one without changing any name that already worked.
  return /^[0-9]/.test(camel) ? `_${camel}` : camel;
}

/**
 * Exported so `exportContractFor` in generate-project.ts can tell a frontend
 * component's generation prompt the EXACT identifier this file's own import
 * will use - `component.name` itself is not safe to use directly (schema
 * component names are free text from Layer 2 or a hand-built fixture, e.g.
 * "Recipe Dashboard" with a space, which is not a valid JS identifier and
 * broke a real live build - see docs/GENERATION.md), so both sides must
 * derive the same sanitized identifier from the same slug rather than one
 * side using the raw name.
 */
export function pascalIdentifier(slug: string): string {
  const camel = importIdentifier(slug);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/**
 * Templated, not LLM-generated, same reasoning as backendEntryPointFile:
 * mounting is the one place most likely to have cross-file wiring bugs, kept
 * out of the model's hands.
 *
 * A real site rather than every page stacked on one screen: a home page with
 * a card per page, a navigation bar, and one page shown at a time, chosen by
 * the address hash (`#/book-list`). Hash links need no router package and work
 * the same from Vite, from `npm start` serving the built site, and from any
 * static host. The bar wraps on a narrow screen.
 */
export function frontendEntryPointFile(frontendComponents: readonly Component[], title = 'App'): GeneratedFile {
  const lines: string[] = [
    "import { StrictMode, useEffect, useState, type ComponentType } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    '',
  ];

  for (const component of frontendComponents) {
    const slug = componentSlug(component.name);
    const identifier = pascalIdentifier(slug);
    lines.push(`import { ${identifier} } from './pages/${slug}';`);
  }

  lines.push(
    '',
    'interface PageEntry {',
    '  readonly path: string;',
    '  readonly title: string;',
    '  readonly purpose: string;',
    '  readonly Page: ComponentType;',
    '}',
    '',
    `const SITE_TITLE = ${JSON.stringify(title)};`,
    'const PAGES: readonly PageEntry[] = [',
    ...frontendComponents.map((component) => {
      const slug = componentSlug(component.name);
      return `  { path: ${JSON.stringify(slug)}, title: ${JSON.stringify(component.name)}, purpose: ${JSON.stringify(component.purpose)}, Page: ${pascalIdentifier(slug)} },`;
    }),
    '];',
    '',
    '/** The page in the address hash: "#/book-list" -> "book-list"; "" is the home page. */',
    'function currentPath(): string {',
    '  const hash = window.location.hash;',
    "  return hash.startsWith('#/') ? hash.slice(2) : hash.slice(1);",
    '}',
    '',
    'function Home(): JSX.Element {',
    '  return (',
    '    <section>',
    "      <h1 style={{ fontSize: '28px', margin: '8px 0 4px' }}>{SITE_TITLE}</h1>",
    "      <p style={{ color: '#555', marginTop: 0 }}>Choose a page to get started.</p>",
    "      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '16px', marginTop: '20px' }}>",
    '        {PAGES.map((entry) => (',
    '          <a',
    '            key={entry.path}',
    '            href={`#/${entry.path}`}',
    "            style={{ display: 'block', padding: '18px', border: '1px solid #ddd', borderRadius: '12px', color: 'inherit', textDecoration: 'none', background: '#fff' }}",
    '          >',
    "            <strong style={{ display: 'block', fontSize: '17px', marginBottom: '6px' }}>{entry.title}</strong>",
    "            <span style={{ color: '#555', fontSize: '14px' }}>{entry.purpose}</span>",
    '          </a>',
    '        ))}',
    '      </div>',
    '    </section>',
    '  );',
    '}',
    '',
    'function App(): JSX.Element {',
    '  const [path, setPath] = useState<string>(currentPath());',
    '  useEffect(() => {',
    '    const onChange = (): void => setPath(currentPath());',
    "    window.addEventListener('hashchange', onChange);",
    "    return () => window.removeEventListener('hashchange', onChange);",
    '  }, []);',
    '  const current = PAGES.find((entry) => entry.path === path);',
    '  return (',
    "    <div style={{ minHeight: '100vh', background: '#f6f7f9', color: '#1a1a1a' }}>",
    "      <nav style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 18px', padding: '12px 20px', background: '#1f2937' }}>",
    "        <a href=\"#/\" style={{ color: '#fff', fontWeight: 700, textDecoration: 'none', marginRight: '8px' }}>{SITE_TITLE}</a>",
    '        {PAGES.map((entry) => (',
    '          <a',
    '            key={entry.path}',
    '            href={`#/${entry.path}`}',
    "            style={{ color: entry.path === path ? '#fff' : '#cbd5e1', textDecoration: entry.path === path ? 'underline' : 'none' }}",
    '          >',
    '            {entry.title}',
    '          </a>',
    '        ))}',
    '      </nav>',
    "      <main style={{ maxWidth: '1100px', margin: '0 auto', padding: '20px 16px' }}>",
    '        {current === undefined ? <Home /> : <current.Page />}',
    '      </main>',
    '    </div>',
    '  );',
    '}',
    '',
    "const container = document.getElementById('root');",
    'if (container === null) {',
    "  throw new Error('#root element not found');",
    '}',
    '',
    'createRoot(container).render(',
    '  <StrictMode>',
    '    <App />',
    '  </StrictMode>,',
    ');',
    '',
  );

  return { path: 'frontend/src/main.tsx', contents: lines.join('\n') };
}
