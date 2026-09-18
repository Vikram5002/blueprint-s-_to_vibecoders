/**
 * Layer 3, Milestone 1: orchestrates one ProjectSchema into a real, written
 * backend project - the narrowest slice proposed in this phase's design
 * (backend + security domains only, one deliberately-violatable constraint,
 * no auto-regeneration loop yet).
 *
 * `buildMilestone1Schema` is a hand-built fixture, not a Layer-2 LLM
 * generation - Layer 2 (`workflow/generate-project-schema.ts`) is already
 * proven, so this milestone isolates the genuinely new ground (per-component
 * code generation, assembly, and the Blueprint verification loop) rather
 * than compounding it with schema-generation's own uncertainty.
 */
import {
  componentId,
  DOMAIN_NAMES,
  type Component,
  type DomainName,
  type ValidatedProjectSchema,
} from '../types/project-schema.js';
import { compileBlueprint } from '../blueprint/dsl.js';
import type { Constraint } from '../types/constraints.js';
import { validateProjectSchema } from '../workflow/validate-project-schema.js';
import {
  createComponentCodeGenerator,
  extractExportedDeclarations,
  extractNamedExports,
  selectRelevantConstraints,
  type ComponentCodeFailure,
  type ComponentGenerationContext,
  type CreateComponentCodeGeneratorOptions,
  type DependencyExportInfo,
} from './component-codegen.js';
import {
  backendEntryPointFile,
  componentSlug,
  componentTargetPath,
  frontendEntryPointFile,
  packageJsonFile,
  pascalIdentifier,
  tsconfigFile,
  type GeneratedFile,
} from './assemble.js';

const USER_ROUTER: Component = {
  id: componentId('backend', 'UserRouter', 'user-router'),
  name: 'UserRouter',
  purpose:
    'Exposes REST endpoints for creating a user account (POST /) and fetching one by id (GET /:id), ' +
    'storing accounts in a plain in-memory array. Also exports a findUserById(id) helper function that ' +
    'looks a user up in that same in-memory array, for other backend code to reuse.',
};

const TASK_ROUTER: Component = {
  id: componentId('backend', 'TaskRouter', 'task-router'),
  name: 'TaskRouter',
  purpose:
    'Exposes REST endpoints for creating a task (POST /), listing all tasks (GET /), and marking one ' +
    'complete (PATCH /:id/complete), storing tasks in a plain in-memory array.',
};

const AUTH_MIDDLEWARE: Component = {
  id: componentId('security', 'AuthMiddleware', 'auth-middleware'),
  name: 'AuthMiddleware',
  purpose:
    'Reads a userId from the x-user-id request header on every request. Verifies the requester is a real ' +
    "user by calling the UserRouter's findUserById(userId) helper directly and checking it returns a user " +
    '(import findUserById from the routes/user-router file for this). If no such user exists, responds ' +
    '401 and stops the request; otherwise calls next().',
};

/**
 * The one constraint this milestone deliberately sets up to be violated:
 * `AuthMiddleware`'s purpose above requires calling a function defined in
 * `backend/src/routes/user-router`, which is exactly what this constraint
 * forbids. This is not fabricated after the fact - the tension is built into
 * the purpose text a real generation call reads, so whether the constraint
 * is actually violated depends on what the model does with that tension, not
 * on anything hand-inserted into the generated file.
 *
 * Phrased as real, resolvable directory paths (not domain names) so
 * Blueprint's subject resolver binds it deterministically via path-pattern
 * matching (`resolveSubject`'s `looksLikePath` branch) rather than through
 * fuzzy module-label matching, which would be unreliable against a
 * three-file generated repository with no meaningful clustering signal.
 */
export const MILESTONE_1_CONSTRAINT_DSL = 'backend/src/middleware must not import backend/src/routes';

const MILESTONE_1_DIRECTORIES: readonly string[] = ['backend/src/middleware', 'backend/src/routes'];

function compileMilestone1Constraint(location: string): Constraint {
  const compiled = compileBlueprint({
    text: MILESTONE_1_CONSTRAINT_DSL,
    location,
    modules: [],
    directories: MILESTONE_1_DIRECTORIES,
  });
  const constraint = compiled.constraints[0];
  if (constraint === undefined) {
    throw new Error(
      `Milestone 1's fixed constraint DSL failed to compile: ${JSON.stringify(compiled.rejected)}`,
    );
  }
  return constraint;
}

/**
 * Builds the one ProjectSchema Milestone 1 generates from: backend (two
 * components) and security (one), database and frontend deliberately empty
 * per the approved scope. Validated before being returned, the same gate a
 * real Layer-2 generation has to pass - a hand-built fixture gets no free
 * pass on shape correctness.
 */
export function buildMilestone1Schema(sessionId: string, constraintLocation: string): ValidatedProjectSchema {
  const candidate = {
    sessionId,
    title: 'Task tracker with auth',
    originalPrompt:
      'A small task tracker: users can sign up, and only requests from a real, existing user may reach ' +
      'the task endpoints.',
    domains: {
      frontend: { components: [], dependsOn: [] },
      backend: { components: [USER_ROUTER, TASK_ROUTER], dependsOn: [] },
      database: { components: [], dependsOn: [] },
      security: { components: [AUTH_MIDDLEWARE], dependsOn: [] },
    },
    constraints: [compileMilestone1Constraint(constraintLocation)],
    provenance: 'STATED' as const,
  };

  const validated = validateProjectSchema(candidate);
  if (!validated.ok) {
    throw new Error(
      `Milestone 1's hand-built fixture schema failed its own validation: ${JSON.stringify(validated.error)}`,
    );
  }
  return validated.value;
}

export interface GenerateProjectFailure {
  readonly component: Component;
  readonly domain: DomainName;
  readonly failure: ComponentCodeFailure;
}

export interface GenerateProjectResult {
  readonly files: readonly GeneratedFile[];
}

/**
 * Generates every component's file (backend first, then security - security
 * depends on backend per the schema's own `dependsOn`, and its prompt names
 * a real backend file path that must already be decided, even though that
 * path is known from convention before any content is generated) and
 * assembles them with the templated, non-LLM package.json/tsconfig/entry
 * point from assemble.ts.
 *
 * Milestone 1 only: frontend and database domains are not handled here even
 * if a caller's schema populated them - this function throws in that case
 * via componentTargetPath rather than silently skipping real components.
 */
export async function generateMilestone1Project(
  schema: ValidatedProjectSchema,
  options: CreateComponentCodeGeneratorOptions,
): Promise<{ readonly ok: true; readonly value: GenerateProjectResult } | { readonly ok: false; readonly error: GenerateProjectFailure }> {
  const generator = createComponentCodeGenerator(options);
  const files: GeneratedFile[] = [packageJsonFile(), tsconfigFile()];

  const backendComponents = schema.domains.backend.components;
  const securityComponents = schema.domains.security.components;

  for (const component of backendComponents) {
    const generated = await generateOne(generator, schema, component, 'backend', files);
    if (!generated.ok) return generated;
    files.push(generated.value);
  }

  for (const component of securityComponents) {
    const generated = await generateOne(generator, schema, component, 'security', files);
    if (!generated.ok) return generated;
    files.push(generated.value);
  }

  files.push(backendEntryPointFile([...backendComponents], [...securityComponents]));

  return { ok: true, value: { files } };
}

async function generateOne(
  generator: ReturnType<typeof createComponentCodeGenerator>,
  schema: ValidatedProjectSchema,
  component: Component,
  domain: 'backend' | 'security',
  generatedSoFar: readonly GeneratedFile[],
): Promise<{ readonly ok: true; readonly value: GeneratedFile } | { readonly ok: false; readonly error: GenerateProjectFailure }> {
  const targetPath = componentTargetPath(domain, component);

  // Milestone 1's only cross-component import: AuthMiddleware is allowed to
  // name UserRouter's file as an available import path so the model can
  // legitimately fulfil its stated purpose - whether doing so also violates
  // the constraint above is exactly what this milestone measures, not
  // something prevented here.
  const userRouterPath = componentTargetPath('backend', USER_ROUTER);
  const dependencies: readonly { readonly importPath: string; readonly sourceTargetPath: string }[] =
    domain === 'security' ? [{ importPath: relativeImportPath(targetPath, userRouterPath), sourceTargetPath: userRouterPath }] : [];

  const context: ComponentGenerationContext = {
    schemaTitle: schema.title,
    component,
    domain,
    targetPath,
    allowedImportPaths: dependencies.map((dep) => dep.importPath),
    availablePackages: ['express'],
    exportContract: exportContractFor(domain, component),
    relevantConstraints: selectRelevantConstraints(schema.constraints, domainKeywords(domain)),
    ...(dependencies.length > 0 ? { dependencyExports: computeDependencyExports(dependencies, generatedSoFar) } : {}),
  };

  const result = await generator.generate(context);
  if (!result.ok) {
    return { ok: false, error: { component, domain, failure: result.error } };
  }
  return { ok: true, value: { path: targetPath, contents: result.value } };
}

function domainKeywords(domain: DomainName): readonly string[] {
  if (domain === 'security') return ['security', 'middleware'];
  if (domain === 'database') return ['database', 'db'];
  if (domain === 'frontend') return ['frontend', 'pages'];
  return ['backend', 'routes'];
}

/** Repo-relative target paths, both posix, to a relative-import specifier without file extension. */
function relativeImportPath(fromFile: string, toFile: string): string {
  const fromDir = fromFile.split('/').slice(0, -1);
  const toParts = toFile.split('/');
  const toName = (toParts.at(-1) ?? '').replace(/\.ts$/, '');
  const toDir = toParts.slice(0, -1);

  let common = 0;
  while (common < fromDir.length && common < toDir.length && fromDir[common] === toDir[common]) common += 1;

  const ups = fromDir.length - common;
  const downs = toDir.slice(common);
  const segments = [...Array(ups).fill('..'), ...downs, toName];
  const joined = segments.join('/');
  return joined.startsWith('.') ? joined : `./${joined}`;
}

// ---------------------------------------------------------------------------
// Milestone 2: database + frontend, all four domains, general orchestrator
// ---------------------------------------------------------------------------

/**
 * Task 1's heuristic, decided and documented rather than silently coded:
 * database generation requires BOTH a real component to generate (an empty
 * `database.components` names nothing to build) AND at least one other
 * domain's `dependsOn` actually naming 'database' (a component nobody
 * consumes would produce dead code no import graph ever reaches, and
 * therefore no constraint could ever be checked against it - the same
 * unmeasured-zero risk this project already tracks for uncheckable
 * constraints). Both conditions absent, or only one, means skip database
 * generation entirely and report it as intentionally empty - never
 * generate-anyway and never silently drop a declared component.
 */
export function schemaImpliesDatabase(schema: ValidatedProjectSchema): boolean {
  if (schema.domains.database.components.length === 0) return false;
  return DOMAIN_NAMES.some(
    (domain) => domain !== 'database' && schema.domains[domain].dependsOn.includes('database'),
  );
}

/**
 * Fixed processing order rather than a general topological sort over
 * `dependsOn` - over-engineering beyond what two fixture schemas need.
 * Correct for both Milestone 1's shape (backend, security) and Milestone
 * 2's (database -> backend -> frontend, security empty): database is
 * generated before anything that might depend on it, frontend last since it
 * only ever depends on backend route paths that must already exist.
 * Extending this to a real topological sort is Milestone 3+ work if a
 * schema ever needs a dependency direction this fixed order does not cover.
 */
const DOMAIN_PROCESSING_ORDER: readonly DomainName[] = ['database', 'backend', 'security', 'frontend'];

/**
 * Every domain's export shape is now stated as a named export with a FIXED,
 * predictable identifier - `router`/`middleware` for backend/security,
 * matching the templated entry points in assemble.ts, which import exactly
 * those names. Frontend is the one domain whose fixed identifier cannot be
 * a shared constant (`RecipeListPage` and `BoardPage` cannot both export
 * something called `page`), so its contract is built per-component by
 * `exportContractFor` below rather than living in this table. See
 * docs/GENERATION.md's "Cross-file export-convention mismatch" limitation
 * for why every domain moved to a single, mandatory named-exports
 * convention instead of the previous mix of default and named exports.
 */
const EXPORT_CONTRACT: Readonly<Record<Exclude<DomainName, 'frontend'>, string>> = {
  database:
    'import { DatabaseSync } from "node:sqlite" - this is Node\'s own built-in SQLite module, NOT the ' +
    '"better-sqlite3" npm package, so never import from "better-sqlite3". Export the DatabaseSync instance ' +
    'as a named export `db` (e.g. `export const db = new DatabaseSync(...)`), using `db.exec(sql)` for ' +
    'schema/DDL statements and `db.prepare(sql).run(...)` / `.get(...)` / `.all(...)` for parameterized ' +
    'queries - never string-concatenated SQL. `.all()` and `.get()` return a generic ' +
    '`Record<string, SQLOutputValue>` shape under TypeScript, not your specific row interface, so a direct ' +
    '`as YourType[]` cast will fail to compile - cast through `unknown` first, e.g. ' +
    '`stmt.all() as unknown as Recipe[]`. `DatabaseSync` has no `.query` method, `db.exec` returns void, and ' +
    'these calls are synchronous - do not await them. Do not write the `SQLOutputValue` type yourself. Export ' +
    'an interface for each row shape, and one named function per query the purpose describes, each with ' +
    'fully typed parameters and an explicit return type. No default export.',
  backend:
    'Export the Express Router as a named export literally called `router` - e.g. ' +
    '`import { Router, type Request, type Response } from "express"; export const router = Router();` - and ' +
    'type every handler `(req: Request, res: Response) => { ... }`. No default export.',
  security:
    'Export the Express middleware function as a named export literally called `middleware`, fully typed - ' +
    'e.g. `import type { Request, Response, NextFunction } from "express"; ' +
    'export function middleware(req: Request, res: Response, next: NextFunction): void { ... }`. No default export. ' +
    'IMPORTANT: this middleware is mounted globally with app.use(middleware), so it runs on EVERY request to ' +
    'the server - every route, every method, including plain GET requests that carry no body. Unless the ' +
    'purpose says it protects every request (e.g. authentication), first check req.method and req.path and ' +
    'call next() immediately for any request the purpose does not cover; only validate or reject the ' +
    'requests it is actually about.',
};

/**
 * Frontend's contract names the export after the component's own name (its
 * generated file is the only one that will ever export something with that
 * identifier, so no collision risk the way a shared `page` name would have)
 * - everything else reuses the fixed, shared table above.
 */
function exportContractFor(domain: DomainName, component: Component): string {
  if (domain === 'frontend') {
    // The required identifier is derived from the component's slug, not its
    // raw `name` - a schema's component name is free text (e.g. "Recipe
    // Dashboard", with a space) and is not guaranteed to be a valid JS
    // identifier. `pascalIdentifier(componentSlug(...))` is the exact same
    // derivation frontendEntryPointFile (assemble.ts) uses for its own
    // import, so the two sides can never disagree - see this file's
    // decision log entry for the live build this mismatch broke.
    const identifier = pascalIdentifier(componentSlug(component.name));
    return (
      `Export the React function component as a named export literally called \`${identifier}\` - e.g. ` +
      `\`export function ${identifier}(...) { ... }\` (import type { FC } from "react" if needed). ` +
      'No default export. Do not call createRoot or render anything yourself, that is handled elsewhere.'
    );
  }
  return EXPORT_CONTRACT[domain];
}

const AVAILABLE_PACKAGES: Readonly<Record<DomainName, readonly string[]>> = {
  // node:sqlite is Node's own built-in module - no npm install needed, and
  // it must never be confused with the "better-sqlite3" package (see
  // docs/GENERATION.md's decision log for why that package was dropped).
  database: ['node:sqlite (built-in, no install required)'],
  backend: ['express'],
  security: ['express'],
  frontend: ['react'],
};

/**
 * Every path a component in `domain` may import from, computed strictly
 * from the schema's own `dependsOn` - unlike Milestone 1's `generateOne`,
 * which hand-allowed one specific cross-domain import regardless of
 * `dependsOn` to test whether an undeclared dependency would surface as a
 * violation. Milestone 2's fixture takes the opposite, arguably more
 * realistic shape: the domain-level dependency IS declared (backend really
 * does depend on database), and the violation this milestone tests for is a
 * finer-grained one - a directory-level rule stricter than what the
 * domain-level dependency alone would allow. Generalizing to
 * `dependsOn`-only keeps this function honest about what it allows instead
 * of encoding a milestone-specific exception into general code.
 *
 * Frontend is a deliberate exception, never a `dependsOn`-driven file
 * import: a browser bundle cannot import an Express Router object across
 * the frontend/backend boundary the way one backend file can import
 * another. A frontend component's dependency on the backend is expressed as
 * `httpEndpoints` instead - see httpEndpointsForDomain below.
 */
function allowedDependenciesForDomain(
  schema: ValidatedProjectSchema,
  domain: DomainName,
  targetPath: string,
): readonly { readonly importPath: string; readonly sourceTargetPath: string }[] {
  if (domain === 'frontend') return [];
  const dependencies: { readonly importPath: string; readonly sourceTargetPath: string }[] = [];
  for (const dep of schema.domains[domain].dependsOn) {
    for (const component of schema.domains[dep].components) {
      const sourceTargetPath = componentTargetPath(dep, component);
      dependencies.push({ importPath: relativeImportPath(targetPath, sourceTargetPath), sourceTargetPath });
    }
  }
  return dependencies;
}

/**
 * The actual fix for the cross-file export-convention mismatch (see
 * docs/GENERATION.md): looks up each dependency's real, already-generated
 * content in `generatedSoFar` (populated by the fixed `DOMAIN_PROCESSING_ORDER`
 * this project already relies on - a component's dependencies are always
 * generated before it is) and extracts its real named exports, rather than
 * letting the consuming component guess. A dependency not yet found in
 * `generatedSoFar` (should not happen given the fixed processing order, but
 * never assumed) reports an empty export list rather than throwing - the
 * model is then told explicitly "no exports found", the same honest-gap
 * posture the rest of this pipeline takes over guessing.
 */
function computeDependencyExports(
  dependencies: readonly { readonly importPath: string; readonly sourceTargetPath: string }[],
  generatedSoFar: readonly GeneratedFile[],
): readonly DependencyExportInfo[] {
  return dependencies.map((dep) => {
    const file = generatedSoFar.find((f) => f.path === dep.sourceTargetPath);
    return file === undefined
      ? { importPath: dep.importPath, exportedNames: [] }
      : {
          importPath: dep.importPath,
          exportedNames: extractNamedExports(file.contents),
          declarations: extractExportedDeclarations(file.contents),
        };
  });
}

/**
 * The real, already-decided route paths a frontend component may call by
 * URL, computed the same way the backend's own entry point mounts them
 * (`/api/<slug>`, see assemble.ts's backendEntryPointFile) - never a guessed
 * path, per Task 3. Only backend components are ever mounted as HTTP
 * routes, so this looks only at the domains the frontend depends on that
 * are 'backend'; a frontend depending on, say, 'database' directly would
 * have nothing to compute here and gets an empty list, same as
 * allowedImportsForDomain would for an unsupported relationship.
 */
function httpEndpointsForDomain(schema: ValidatedProjectSchema, domain: DomainName): string[] {
  if (domain !== 'frontend') return [];
  const endpoints: string[] = [];
  for (const dep of schema.domains[domain].dependsOn) {
    if (dep !== 'backend') continue;
    for (const component of schema.domains[dep].components) {
      endpoints.push(`/api/${componentSlug(component.name)}`);
    }
  }
  return endpoints;
}

/**
 * Exported (unlike Milestone 1's `generateOne`) because Milestone 3's
 * verify-and-regenerate loop needs to call this a second time for exactly
 * one component, with `priorViolation` set - the same generation path a
 * fresh component takes, just with corrective context appended to the
 * prompt (see component-codegen.ts's `PriorViolationContext`).
 */
export async function generateComponentFile(
  generator: ReturnType<typeof createComponentCodeGenerator>,
  schema: ValidatedProjectSchema,
  component: Component,
  domain: DomainName,
  priorViolation?: ComponentGenerationContext['priorViolation'],
  generatedSoFar: readonly GeneratedFile[] = [],
): Promise<{ readonly ok: true; readonly value: GeneratedFile } | { readonly ok: false; readonly error: GenerateProjectFailure }> {
  const targetPath = componentTargetPath(domain, component);
  const dependencies = allowedDependenciesForDomain(schema, domain, targetPath);

  const context: ComponentGenerationContext = {
    schemaTitle: schema.title,
    component,
    domain,
    targetPath,
    allowedImportPaths: dependencies.map((dep) => dep.importPath),
    httpEndpoints: httpEndpointsForDomain(schema, domain),
    availablePackages: AVAILABLE_PACKAGES[domain],
    exportContract: exportContractFor(domain, component),
    relevantConstraints: selectRelevantConstraints(schema.constraints, domainKeywords(domain)),
    ...(priorViolation === undefined ? {} : { priorViolation }),
    ...(dependencies.length > 0 ? { dependencyExports: computeDependencyExports(dependencies, generatedSoFar) } : {}),
  };

  const result = await generator.generate(context);
  if (!result.ok) {
    return { ok: false, error: { component, domain, failure: result.error } };
  }
  return { ok: true, value: { path: targetPath, contents: result.value } };
}

/**
 * Finds which schema component a real generated file path belongs to, by
 * recomputing every component's conventional target path and matching -
 * the same convention componentTargetPath already defines, run in reverse.
 * Used by Milestone 3's verify-and-regenerate loop to turn a Blueprint
 * violation's `fromFile` back into the one component to regenerate. Returns
 * null for a path that belongs to no component (a templated entry point
 * like backend/src/index.ts, which nothing ever regenerates).
 */
export function findComponentByTargetPath(
  schema: ValidatedProjectSchema,
  targetPath: string,
): { readonly component: Component; readonly domain: DomainName } | null {
  for (const domain of DOMAIN_NAMES) {
    for (const component of schema.domains[domain].components) {
      if (componentTargetPath(domain, component) === targetPath) {
        return { component, domain };
      }
    }
  }
  return null;
}

/**
 * General orchestrator across all four domains - the Milestone 2
 * generalization of generateMilestone1Project. That function is left
 * untouched rather than rewritten in terms of this one: it is already
 * committed, tested, and verified against real Milestone 1 output, and its
 * one deliberate exception (allowing an import `dependsOn` does not
 * authorize, to test whether an undeclared dependency surfaces as a
 * violation) does not generalize cleanly into this function's stricter,
 * `dependsOn`-only import rule. Still no auto-regeneration retry - deferred
 * to Milestone 3 per the approved scope.
 */
export async function generateProject(
  schema: ValidatedProjectSchema,
  options: CreateComponentCodeGeneratorOptions,
): Promise<{ readonly ok: true; readonly value: GenerateProjectResult } | { readonly ok: false; readonly error: GenerateProjectFailure }> {
  const generator = createComponentCodeGenerator(options);
  const includeDatabase = schemaImpliesDatabase(schema);
  const hasFrontend = schema.domains.frontend.components.length > 0;

  const files: GeneratedFile[] = [
    packageJsonFile({ database: includeDatabase, frontend: hasFrontend }),
    tsconfigFile({ frontend: hasFrontend }),
  ];

  for (const domain of DOMAIN_PROCESSING_ORDER) {
    if (domain === 'database' && !includeDatabase) continue;
    for (const component of schema.domains[domain].components) {
      const generated = await generateComponentFile(generator, schema, component, domain, undefined, files);
      if (!generated.ok) return generated;
      files.push(generated.value);
    }
  }

  files.push(backendEntryPointFile([...schema.domains.backend.components], [...schema.domains.security.components]));
  if (hasFrontend) {
    files.push(frontendEntryPointFile([...schema.domains.frontend.components]));
  }

  return { ok: true, value: { files } };
}

const RECIPE_STORE: Component = {
  id: componentId('database', 'RecipeStore', 'recipe-store'),
  name: 'RecipeStore',
  purpose:
    'Initializes a node:sqlite database file at backend/recipes.db with a `recipes` table (columns: id ' +
    'INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, ingredients TEXT NOT NULL, created_at TEXT NOT ' +
    'NULL), creating the table if it does not already exist. Exports two named functions: insertRecipe(title, ' +
    'ingredients) which inserts a row (created_at set to the current ISO timestamp) and returns the new row\'s ' +
    'id, and listRecipes() which returns every row ordered by created_at descending.',
};

const RECIPE_ROUTER: Component = {
  id: componentId('backend', 'RecipeRouter', 'recipe-router'),
  name: 'RecipeRouter',
  purpose:
    'Exposes REST endpoints for creating a recipe (POST / with a JSON body of { title, ingredients }) and ' +
    "listing every saved recipe (GET /), calling the database domain's insertRecipe and listRecipes functions " +
    'directly to persist and read data from the real recipes table (import them from the db/recipe-store ' +
    'file).',
};

const RECIPE_LIST_PAGE: Component = {
  id: componentId('frontend', 'RecipeListPage', 'recipe-list-page'),
  name: 'RecipeListPage',
  purpose:
    "Renders a page that, on mount, fetches the list of recipes from the backend's real GET " +
    '/api/recipe-router endpoint and displays each recipe\'s title and ingredients, plus a form (title and ' +
    'ingredients text inputs and a submit button) that POSTs a new recipe as JSON to that same endpoint and ' +
    're-fetches the list on success.',
};

/**
 * Milestone 2's deliberate violation, deliberately different in shape from
 * Milestone 1's: there, the domain-level `dependsOn` did NOT authorize the
 * import at all (security.dependsOn was empty). Here, backend.dependsOn DOES
 * include 'database' - the domain-level relationship is legitimate - but
 * this finer-grained, real-path constraint says routes must not import the
 * db module's file directly at all, modelling a common real convention
 * (routes stay thin; persistence logic is called through a
 * repository/service boundary a later milestone would add) that
 * RecipeRouter's purpose above is written in tension with - it is told to
 * call insertRecipe/listRecipes directly, which requires exactly the
 * import this constraint forbids. Whether the
 * model takes that tension into an actual violation is what this milestone
 * measures, the same posture Milestone 1's constraint took.
 */
export const MILESTONE_2_CONSTRAINT_DSL = 'backend/src/routes must not import backend/src/db';

const MILESTONE_2_DIRECTORIES: readonly string[] = ['backend/src/routes', 'backend/src/db'];

function compileMilestone2Constraint(location: string): Constraint {
  const compiled = compileBlueprint({
    text: MILESTONE_2_CONSTRAINT_DSL,
    location,
    modules: [],
    directories: MILESTONE_2_DIRECTORIES,
  });
  const constraint = compiled.constraints[0];
  if (constraint === undefined) {
    throw new Error(
      `Milestone 2's fixed constraint DSL failed to compile: ${JSON.stringify(compiled.rejected)}`,
    );
  }
  return constraint;
}

/**
 * Builds Milestone 2's ProjectSchema: a genuinely different application
 * from Milestone 1's task tracker (a recipe box, not an auth-gated task
 * list), exercising the two domains Milestone 1 left empty - database (one
 * component, real SQL) and frontend (one component, consuming the real
 * generated backend route) - while security stays empty this time,
 * inverting which domains are populated relative to Milestone 1 rather than
 * only adding to the same shape.
 */
export function buildMilestone2Schema(sessionId: string, constraintLocation: string): ValidatedProjectSchema {
  const candidate = {
    sessionId,
    title: 'Recipe box',
    originalPrompt:
      'A simple recipe box: save recipes with a title and an ingredients list, and browse every saved ' +
      'recipe, backed by a real persistent database.',
    domains: {
      frontend: { components: [RECIPE_LIST_PAGE], dependsOn: ['backend'] },
      backend: { components: [RECIPE_ROUTER], dependsOn: ['database'] },
      database: { components: [RECIPE_STORE], dependsOn: [] },
      security: { components: [], dependsOn: [] },
    },
    constraints: [compileMilestone2Constraint(constraintLocation)],
    provenance: 'STATED' as const,
  };

  const validated = validateProjectSchema(candidate);
  if (!validated.ok) {
    throw new Error(
      `Milestone 2's hand-built fixture schema failed its own validation: ${JSON.stringify(validated.error)}`,
    );
  }
  return validated.value;
}

// ---------------------------------------------------------------------------
// Milestone 3: scale test - a genuinely larger schema, all four domains,
// two real constraints
// ---------------------------------------------------------------------------

/** Shared by every Milestone 3 scale-test constraint - see compileMilestone1Constraint/compileMilestone2Constraint for the one-constraint-per-milestone precedent this generalizes. */
function compileConstraint(text: string, directories: readonly string[], location: string): Constraint {
  const compiled = compileBlueprint({ text, location, modules: [], directories });
  const constraint = compiled.constraints[0];
  if (constraint === undefined) {
    throw new Error(`Scale-test constraint DSL failed to compile: ${text} -> ${JSON.stringify(compiled.rejected)}`);
  }
  return constraint;
}

const TASK_STORE: Component = {
  id: componentId('database', 'TaskStore', 'task-store'),
  name: 'TaskStore',
  purpose:
    'Initializes a node:sqlite table `tasks` (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, ' +
    'status TEXT NOT NULL DEFAULT \'open\', assignee_id INTEGER) in the shared database file at ' +
    'backend/app.db, creating it if absent. Exports named functions insertTask(title, assigneeId), ' +
    'listTasks() (all rows), and setTaskStatus(id, status).',
};

const USER_STORE: Component = {
  id: componentId('database', 'UserStore', 'user-store'),
  name: 'UserStore',
  purpose:
    'Initializes a node:sqlite table `users` (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ' +
    'email TEXT NOT NULL) in the shared database file at backend/app.db, creating it if absent. Exports ' +
    'named functions insertUser(name, email), findUserById(id), and listUsers().',
};

const COMMENT_STORE: Component = {
  id: componentId('database', 'CommentStore', 'comment-store'),
  name: 'CommentStore',
  purpose:
    'Initializes a node:sqlite table `comments` (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT ' +
    'NULL, author_id INTEGER NOT NULL, body TEXT NOT NULL) in the shared database file at backend/app.db, ' +
    'creating it if absent. Exports named functions insertComment(taskId, authorId, body) and ' +
    'listCommentsForTask(taskId).',
};

const SCALE_TASK_ROUTER: Component = {
  id: componentId('backend', 'TaskRouter', 'scale-task-router'),
  name: 'TaskRouter',
  purpose:
    'Exposes REST endpoints for creating a task (POST / with { title, assigneeId }), listing every task ' +
    '(GET /), and updating a task\'s status (PATCH /:id/status with { status }), calling the database ' +
    "domain's TaskStore functions (insertTask, listTasks, setTaskStatus) directly, imported from the " +
    'db/task-store file, to persist and read real rows.',
};

const SCALE_USER_ROUTER: Component = {
  id: componentId('backend', 'UserRouter', 'scale-user-router'),
  name: 'UserRouter',
  purpose:
    'Exposes REST endpoints for creating a user (POST / with { name, email }) and listing every user ' +
    "(GET /), calling the database domain's UserStore functions (insertUser, listUsers) directly, " +
    'imported from the db/user-store file, to persist and read real rows.',
};

const COMMENT_ROUTER: Component = {
  id: componentId('backend', 'CommentRouter', 'comment-router'),
  name: 'CommentRouter',
  purpose:
    'Exposes REST endpoints for adding a comment to a task (POST / with { taskId, authorId, body }) and ' +
    "listing every comment for a task (GET /?taskId=), calling the database domain's CommentStore " +
    'functions (insertComment, listCommentsForTask) directly, imported from the db/comment-store file, to ' +
    'persist and read real rows.',
};

const AUTH_MIDDLEWARE_SCALE: Component = {
  id: componentId('security', 'AuthMiddleware', 'auth-middleware-scale'),
  name: 'AuthMiddleware',
  purpose:
    'Reads a userId from the x-user-id request header on every request and rejects with 401 if the header ' +
    'is missing or empty. Does not look up the user anywhere - it only checks the header is present - so ' +
    'it needs no knowledge of how users are stored.',
};

const BOARD_PAGE: Component = {
  id: componentId('frontend', 'BoardPage', 'board-page'),
  name: 'BoardPage',
  purpose:
    "Renders a page that, on mount, fetches every task from the backend's real GET /api/task-router " +
    "endpoint and every comment for the first task from GET /api/comment-router?taskId=1, displaying " +
    'tasks grouped by status with their comment counts. No form, read-only for this component.',
};

const LOGIN_PAGE: Component = {
  id: componentId('frontend', 'LoginPage', 'login-page'),
  name: 'LoginPage',
  purpose:
    'Renders a simple form (name and email text inputs, a submit button) that POSTs a new user as JSON to ' +
    "the backend's real /api/user-router endpoint and shows a success message once the request completes.",
};

/**
 * Two real constraints, deliberately spanning two different domain pairs
 * rather than two variants of the same rule - both in the same
 * real-path-based style Milestones 1 and 2 already proved Blueprint's
 * subject resolver binds deterministically:
 *
 * - The Milestone 2 rule, generalized: no backend route may reach into
 *   the database layer directly - applies to all three routers at once,
 *   since the directory pattern covers the whole backend/src/db folder,
 *   not one specific file.
 * - A second, independent rule in the Milestone 1 family: the security
 *   layer may not reach into the routes layer. AuthMiddleware's purpose
 *   above is written to need no such thing (see its own docstring), so
 *   this constraint is expected to be satisfied, not violated - included
 *   to prove "correctly evaluated" covers the satisfied case too, not
 *   only the violated one Milestones 1 and 2 each happened to produce.
 */
export const SCALE_TEST_CONSTRAINT_DSL_1 = 'backend/src/routes must not import backend/src/db';
export const SCALE_TEST_CONSTRAINT_DSL_2 = 'backend/src/middleware must not import backend/src/routes';

/**
 * Builds a schema with 3x Milestone 2's component count (9 vs. 3), spanning
 * all four domains and two independent constraints - the scale Milestone 3
 * Task 3 asks for, not a trivial variant of Milestone 2's Recipe Box.
 */
export function buildScaleTestSchema(sessionId: string, constraintLocation: string): ValidatedProjectSchema {
  const candidate = {
    sessionId,
    title: 'Team task board',
    originalPrompt:
      'A small team task board: create users, assign tasks to them, comment on tasks, and see everything ' +
      'on one board. Every request must come from a real, identified user.',
    domains: {
      frontend: { components: [BOARD_PAGE, LOGIN_PAGE], dependsOn: ['backend'] },
      backend: { components: [SCALE_TASK_ROUTER, SCALE_USER_ROUTER, COMMENT_ROUTER], dependsOn: ['database'] },
      database: { components: [TASK_STORE, USER_STORE, COMMENT_STORE], dependsOn: [] },
      security: { components: [AUTH_MIDDLEWARE_SCALE], dependsOn: [] },
    },
    constraints: [
      compileConstraint(SCALE_TEST_CONSTRAINT_DSL_1, ['backend/src/routes', 'backend/src/db'], constraintLocation),
      compileConstraint(SCALE_TEST_CONSTRAINT_DSL_2, ['backend/src/middleware', 'backend/src/routes'], constraintLocation),
    ],
    provenance: 'STATED' as const,
  };

  const validated = validateProjectSchema(candidate);
  if (!validated.ok) {
    throw new Error(
      `Scale-test hand-built fixture schema failed its own validation: ${JSON.stringify(validated.error)}`,
    );
  }
  return validated.value;
}
