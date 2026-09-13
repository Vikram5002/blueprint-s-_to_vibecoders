/**
 * Layer 3, Milestone 1: turns individually-generated component files into one
 * coherent, installable backend project.
 *
 * Milestone 1 scope only (backend + security domains; see
 * docs — proposal §5): frontend and database scaffolding are deliberately
 * absent. `package.json`, `tsconfig.json`, and the entry point that mounts
 * every route are templated here, never LLM-generated — the one place most
 * likely to have cross-file wiring bugs is kept out of the model's hands
 * entirely, per the approved design.
 */
import type { Component, DomainName } from '../types/project-schema.js';

export interface GeneratedFile {
  /** Repo-relative path, posix separators, relative to the project root. */
  readonly path: string;
  readonly contents: string;
}

/**
 * Fixed stack, locked per the approved design: Express + TypeScript for the
 * backend, CommonJS module output (not ESM) so relative imports need no
 * `.js` extension — one fewer thing a freshly generated file has to get
 * right. No alternative stack is considered; see CLAUDE.md-adjacent project
 * history this phase's proposal cites.
 */
const PACKAGE_JSON_TEMPLATE = {
  name: 'generated-backend',
  private: true,
  version: '0.0.0',
  scripts: {
    build: 'tsc',
    start: 'node dist/backend/src/index.js',
  },
  dependencies: {
    express: '^4.19.2',
  },
  devDependencies: {
    typescript: '^5.5.4',
    '@types/express': '^4.17.21',
    '@types/node': '^20.14.0',
  },
} as const;

export function packageJsonFile(): GeneratedFile {
  return { path: 'package.json', contents: `${JSON.stringify(PACKAGE_JSON_TEMPLATE, null, 2)}\n` };
}

export function tsconfigFile(): GeneratedFile {
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
    },
    include: ['backend/**/*.ts'],
  };
  return { path: 'tsconfig.json', contents: `${JSON.stringify(tsconfig, null, 2)}\n` };
}

/**
 * Milestone-1 file convention, folding the security domain into the
 * backend's own middleware folder (approved design §1: "security domain has
 * no runtime of its own ... compiles to Express middleware living inside
 * backend/"). Frontend and database conventions are not implemented yet -
 * this milestone's ProjectSchema has empty domains for both.
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
  throw new Error(`Milestone 1 has no file convention for the "${domain}" domain yet`);
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
