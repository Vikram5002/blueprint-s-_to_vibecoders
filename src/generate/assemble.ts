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
import type { Component, DomainName } from '../types/project-schema.js';

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
export function componentSlug(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
}

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
 * `/api/<slug>`. Assumes each generated file's default export matches the
 * contract stated in its own generation prompt (an Express Router for
 * backend components, an Express middleware function for security ones) -
 * if a generated file's export shape does not match, `tsc` fails to build
 * and that failure is reported honestly rather than patched around here.
 */
export function backendEntryPointFile(
  backendComponents: readonly Component[],
  securityComponents: readonly Component[],
): GeneratedFile {
  const lines: string[] = [
    "import express from 'express';",
    '',
  ];

  for (const component of securityComponents) {
    const slug = componentSlug(component.name);
    lines.push(`import ${importIdentifier(slug)} from './middleware/${slug}';`);
  }
  for (const component of backendComponents) {
    const slug = componentSlug(component.name);
    lines.push(`import ${importIdentifier(slug)} from './routes/${slug}';`);
  }

  lines.push('', 'const app = express();', 'app.use(express.json());', '');

  for (const component of securityComponents) {
    const slug = componentSlug(component.name);
    lines.push(`app.use(${importIdentifier(slug)});`);
  }
  lines.push('');
  for (const component of backendComponents) {
    const slug = componentSlug(component.name);
    lines.push(`app.use('/api/${slug}', ${importIdentifier(slug)});`);
  }

  lines.push(
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
  return slug.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function pascalIdentifier(slug: string): string {
  const camel = importIdentifier(slug);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/**
 * Templated, not LLM-generated, same reasoning as backendEntryPointFile:
 * mounting is the one place most likely to have cross-file wiring bugs, kept
 * out of the model's hands. Milestone 2 scope only - every frontend
 * component's default-exported React component is stacked in one root, no
 * router. Real multi-page routing (react-router, per-page URLs) is "frontend
 * -database wiring correctness at scale", explicitly deferred to Milestone
 * 3 alongside the auto-regeneration loop.
 */
export function frontendEntryPointFile(frontendComponents: readonly Component[]): GeneratedFile {
  const lines: string[] = ["import { StrictMode } from 'react';", "import { createRoot } from 'react-dom/client';", ''];

  for (const component of frontendComponents) {
    const slug = componentSlug(component.name);
    lines.push(`import ${pascalIdentifier(slug)} from './pages/${slug}';`);
  }

  lines.push(
    '',
    "const container = document.getElementById('root');",
    'if (container === null) {',
    "  throw new Error('#root element not found');",
    '}',
    '',
    'createRoot(container).render(',
    '  <StrictMode>',
    '    <>',
    // JSX treats a lowercase-first tag as a DOM element, not the imported
    // component - the identifier here must be PascalCase, unlike
    // backendEntryPointFile's camelCase router/middleware variables, which
    // are never used as a JSX tag.
    ...frontendComponents.map((component) => `      <${pascalIdentifier(componentSlug(component.name))} />`),
    '    </>',
    '  </StrictMode>,',
    ');',
    '',
  );

  return { path: 'frontend/src/main.tsx', contents: lines.join('\n') };
}
