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
import { componentId, type Component, type ValidatedProjectSchema } from '../types/project-schema.js';
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
  componentTargetPath,
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
  readonly domain: 'backend' | 'security';
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

function domainKeywords(domain: 'backend' | 'security'): readonly string[] {
  return domain === 'security' ? ['security', 'middleware'] : ['backend', 'routes'];
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
