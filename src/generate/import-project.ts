/**
 * Import a project a person has been building - usually one this tool
 * generated, downloaded, and then continued by hand - so it can be opened,
 * edited and extended in the workspace like any generated run.
 *
 * Deterministic, no model: the plan (ProjectSchema) is read back from the
 * project's own layout, the same conventions assemble.ts writes -
 *
 *   backend/src/routes/<slug>.ts      -> backend component
 *   backend/src/middleware/<slug>.ts  -> security component
 *   backend/src/db/<slug>.ts          -> database component
 *   frontend/src/pages/<slug>.tsx     -> frontend component
 *
 * and its architecture rules from its own generated.blueprint. Every other
 * file (a helper the person added, a README, their package.json) is kept
 * as it is. A folder with none of these is refused with the reason, rather
 * than mapped by guesswork.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { compileBlueprint } from '../blueprint/dsl.js';
import { componentSlug, type GeneratedFile } from './assemble.js';
import { componentId, type Component, type DomainName, type ProjectSchema, type ValidatedProjectSchema } from '../types/project-schema.js';
import type { Result } from '../types/result.js';
import { validateProjectSchema } from '../workflow/validate-project-schema.js';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vibe', '.next', 'build', 'coverage']);
const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
const TEXT_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|css|html|blueprint|yml|yaml|env\.example|gitignore)$|^\.gitignore$/i;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 2000;

/** The project's text files, repo-relative with / separators; build output, dependencies and binaries skipped. */
export async function readProjectFiles(root: string): Promise<readonly GeneratedFile[]> {
  const files: GeneratedFile[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (files.length >= MAX_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!entry.isFile() || SKIP_FILES.has(entry.name) || entry.name.endsWith('.db') || !TEXT_EXTENSIONS.test(entry.name)) continue;
      if ((await stat(full)).size > MAX_FILE_BYTES) continue;
      files.push({ path: relative(root, full).split(sep).join('/'), contents: await readFile(full, 'utf8') });
    }
  }
  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const COMPONENT_FOLDERS: readonly { readonly domain: DomainName; readonly pattern: RegExp }[] = [
  { domain: 'backend', pattern: /^backend\/src\/routes\/([a-z0-9-]+)\.ts$/ },
  { domain: 'security', pattern: /^backend\/src\/middleware\/([a-z0-9-]+)\.ts$/ },
  { domain: 'database', pattern: /^backend\/src\/db\/([a-z0-9-]+)\.ts$/ },
  { domain: 'frontend', pattern: /^frontend\/src\/pages\/([a-z0-9-]+)\.tsx$/ },
];

/** "participant-registration-form" -> "Participant Registration Form": a name whose slug is the file's own slug. */
function nameFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export interface ImportedPlan {
  readonly schema: ValidatedProjectSchema;
  /** Rule lines from generated.blueprint the compiler could not use - reported, never silently dropped. */
  readonly rejectedRules: readonly string[];
}

export interface ImportIdentity {
  readonly sessionId: string;
  readonly title: string;
  readonly prompt: string;
}

export function schemaFromProjectFiles(files: readonly GeneratedFile[], identity: ImportIdentity): Result<ImportedPlan, string> {
  const components: Record<DomainName, Component[]> = { frontend: [], backend: [], database: [], security: [] };
  for (const file of files) {
    for (const { domain, pattern } of COMPONENT_FOLDERS) {
      const slug = pattern.exec(file.path)?.[1];
      if (slug === undefined) continue;
      const name = nameFromSlug(slug);
      if (componentSlug(name) !== slug) continue;
      const purpose = `Existing ${domain} code imported from ${file.path} - keep its behaviour; extend it only where asked.`;
      components[domain].push({ id: componentId(domain, name, purpose), name, purpose });
    }
  }
  const total = Object.values(components).reduce((n, list) => n + list.length, 0);
  if (total === 0) {
    return {
      ok: false,
      error:
        'no components found - this importer reads projects in this tool\'s layout (backend/src/routes, backend/src/middleware, ' +
        'backend/src/db, frontend/src/pages). A folder with a different structure cannot be mapped without guessing.',
    };
  }

  const has = (domain: DomainName): boolean => components[domain].length > 0;
  const blueprint = files.find((file) => file.path === 'generated.blueprint')?.contents ?? '';
  const compiled = compileBlueprint({
    text: blueprint,
    location: 'generated.blueprint',
    modules: [],
    directories: ['frontend', 'backend', 'backend/src/routes', 'backend/src/middleware', 'backend/src/db', 'frontend/src/pages'],
  });

  const candidate: ProjectSchema = {
    sessionId: identity.sessionId,
    title: identity.title,
    originalPrompt: identity.prompt,
    domains: {
      frontend: { components: components.frontend, dependsOn: has('backend') ? ['backend'] : [] },
      backend: { components: components.backend, dependsOn: has('database') ? ['database'] : [] },
      database: { components: components.database, dependsOn: [] },
      security: { components: components.security, dependsOn: [] },
    },
    constraints: compiled.constraints,
    provenance: 'STATED',
  };
  const validated = validateProjectSchema(candidate);
  if (!validated.ok) return { ok: false, error: `imported plan failed validation: ${JSON.stringify(validated.error.slice(0, 3))}` };
  return { ok: true, value: { schema: validated.value, rejectedRules: compiled.rejected.map((r) => JSON.stringify(r)) } };
}

/**
 * The person's package.json with anything the plan needs added, never
 * anything of theirs removed or changed: a dependency they added by hand
 * survives every regeneration.
 */
export function mergePackageJson(theirs: string, template: string): string {
  let mine: Record<string, unknown>;
  let base: Record<string, unknown>;
  try {
    mine = JSON.parse(theirs) as Record<string, unknown>;
    base = JSON.parse(template) as Record<string, unknown>;
  } catch {
    return theirs;
  }
  const merged: Record<string, unknown> = { ...base, ...mine };
  for (const key of ['scripts', 'dependencies', 'devDependencies', 'engines']) {
    const a = base[key];
    const b = mine[key];
    if (typeof a === 'object' || typeof b === 'object') merged[key] = { ...(a as object | undefined), ...(b as object | undefined) };
  }
  return `${JSON.stringify(merged, null, 2)}\n`;
}
