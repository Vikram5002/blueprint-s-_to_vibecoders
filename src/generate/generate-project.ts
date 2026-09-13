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
  selectRelevantConstraints,
  type ComponentCodeFailure,
  type ComponentGenerationContext,
  type CreateComponentCodeGeneratorOptions,
} from './component-codegen.js';
import {
  backendEntryPointFile,
  componentSlug,
  componentTargetPath,
  frontendEntryPointFile,
  packageJsonFile,
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
    const generated = await generateOne(generator, schema, component, 'backend');
    if (!generated.ok) return generated;
    files.push(generated.value);
  }

  for (const component of securityComponents) {
    const generated = await generateOne(generator, schema, component, 'security');
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
): Promise<{ readonly ok: true; readonly value: GeneratedFile } | { readonly ok: false; readonly error: GenerateProjectFailure }> {
  const targetPath = componentTargetPath(domain, component);

  // Milestone 1's only cross-component import: AuthMiddleware is allowed to
  // name UserRouter's file as an available import path so the model can
  // legitimately fulfil its stated purpose - whether doing so also violates
  // the constraint above is exactly what this milestone measures, not
  // something prevented here.
  const allowedImportPaths =
    domain === 'security' ? [relativeImportPath(targetPath, componentTargetPath('backend', USER_ROUTER))] : [];

  const context: ComponentGenerationContext = {
    schemaTitle: schema.title,
    component,
    domain,
    targetPath,
    allowedImportPaths,
    availablePackages: ['express'],
    exportContract:
      domain === 'backend'
        ? 'export default an Express Router (import { Router } from "express")'
        : 'export default an Express middleware function (req, res, next)',
    relevantConstraints: selectRelevantConstraints(schema.constraints, domainKeywords(domain)),
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

const EXPORT_CONTRACT: Readonly<Record<DomainName, string>> = {
  database:
    'import { DatabaseSync } from "node:sqlite" - this is Node\'s own built-in SQLite module, NOT the ' +
    '"better-sqlite3" npm package, so never import from "better-sqlite3". Export the DatabaseSync instance ' +
    'as a named export `db` (e.g. `export const db = new DatabaseSync(...)`), using `db.exec(sql)` for ' +
    'schema/DDL statements and `db.prepare(sql).run(...)` / `.get(...)` / `.all(...)` for parameterized ' +
    'queries - never string-concatenated SQL. `.all()` and `.get()` return a generic ' +
    '`Record<string, SQLOutputValue>` shape under TypeScript, not your specific row interface, so a direct ' +
    '`as YourType[]` cast will fail to compile - cast through `unknown` first, e.g. ' +
    '`stmt.all() as unknown as Recipe[]`. Also export one named function per query the purpose describes. ' +
    'No default export.',
  backend: 'export default an Express Router (import { Router } from "express")',
  security: 'export default an Express middleware function (req, res, next)',
  frontend:
    'export default a React function component (import type { FC } from "react" if needed); do not call ' +
    'createRoot or render anything yourself, that is handled elsewhere',
};

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
function allowedImportsForDomain(schema: ValidatedProjectSchema, domain: DomainName, targetPath: string): string[] {
  if (domain === 'frontend') return [];
  const paths: string[] = [];
  for (const dep of schema.domains[domain].dependsOn) {
    for (const component of schema.domains[dep].components) {
      paths.push(relativeImportPath(targetPath, componentTargetPath(dep, component)));
    }
  }
  return paths;
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

async function generateComponentFile(
  generator: ReturnType<typeof createComponentCodeGenerator>,
  schema: ValidatedProjectSchema,
  component: Component,
  domain: DomainName,
): Promise<{ readonly ok: true; readonly value: GeneratedFile } | { readonly ok: false; readonly error: GenerateProjectFailure }> {
  const targetPath = componentTargetPath(domain, component);

  const context: ComponentGenerationContext = {
    schemaTitle: schema.title,
    component,
    domain,
    targetPath,
    allowedImportPaths: allowedImportsForDomain(schema, domain, targetPath),
    httpEndpoints: httpEndpointsForDomain(schema, domain),
    availablePackages: AVAILABLE_PACKAGES[domain],
    exportContract: EXPORT_CONTRACT[domain],
    relevantConstraints: selectRelevantConstraints(schema.constraints, domainKeywords(domain)),
  };

  const result = await generator.generate(context);
  if (!result.ok) {
    return { ok: false, error: { component, domain, failure: result.error } };
  }
  return { ok: true, value: { path: targetPath, contents: result.value } };
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
      const generated = await generateComponentFile(generator, schema, component, domain);
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
