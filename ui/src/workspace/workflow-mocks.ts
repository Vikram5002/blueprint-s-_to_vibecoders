import type { Component, ProjectSchema } from './project-schema-types';
import type { Constraint, ResolvedSubject } from './verification-types';

/**
 * Mock ProjectSchema data — the orchestrator that generates real ones does
 * not exist yet (see src/types/project-schema.ts's own header comment).
 * Two schemas: a realistic small one for the normal demo path, and a
 * deliberately oversized one (350 components in one domain) to prove the
 * pagination scale guard actually holds rather than being untested.
 */

let idCounter = 0;
function component(name: string, purpose: string): Component {
  idCounter += 1;
  return { id: `mock-component-${idCounter}`, name, purpose };
}

/**
 * A domain name is exact and unambiguous by construction at the ProjectSchema
 * stage — there is no fuzzy matching to do, unlike resolving a prose phrase
 * against a derived module. `target` is the domain name itself.
 */
function domainRole(name: string): ResolvedSubject {
  return {
    phrase: name,
    status: 'MODULE',
    target: name,
    reason: null,
    similarity: 1,
    alternatives: [],
  };
}

/**
 * A real, resolvable directory path - not a domain name - matching how
 * src/blueprint/dsl.ts's `compileBlueprint` actually resolves a path-shaped
 * phrase (`resolveSubject`'s `looksLikePath` branch), used by
 * KNOWN_TENSION_SCHEMA below since that fixture is meant to be handed
 * straight to Layer 3's real generation+verification loop, which resolves
 * constraints against real generated file paths, not domain labels.
 */
function pathRole(pattern: string): ResolvedSubject {
  return {
    phrase: pattern,
    status: 'PATH_PATTERN',
    target: `${pattern}/**`,
    reason: null,
    similarity: 1,
    alternatives: [],
  };
}

let constraintCounter = 0;
function domainConstraint(
  relation: Constraint['relation'],
  subjectDomain: string,
  objectDomain: string,
  rawText: string,
): Constraint {
  constraintCounter += 1;
  return {
    id: `mock-project-constraint-${constraintCounter}`,
    relation,
    subject: domainRole(subjectDomain),
    object: domainRole(objectDomain),
    via: null,
    source: { type: 'user-authored', location: 'project prompt', line: null, timestamp: null },
    confidence: 1,
    lowConfidence: false,
    rawText,
    provenance: 'STATED',
  };
}

/** Same as domainConstraint, but subject/object are real directory paths - see KNOWN_TENSION_SCHEMA. */
function pathConstraint(
  relation: Constraint['relation'],
  subjectPath: string,
  objectPath: string,
  rawText: string,
): Constraint {
  constraintCounter += 1;
  return {
    id: `mock-project-constraint-${constraintCounter}`,
    relation,
    subject: pathRole(subjectPath),
    object: pathRole(objectPath),
    via: null,
    source: { type: 'user-authored', location: 'project prompt', line: null, timestamp: null },
    confidence: 1,
    lowConfidence: false,
    rawText,
    provenance: 'STATED',
  };
}

// --- Scenario 1: a realistic small schema ----------------------------------

export const SMALL_PROJECT_SCHEMA: ProjectSchema = {
  sessionId: 'mock-session-1',
  title: 'Order management app',
  originalPrompt:
    'Build an app where customers can place orders and track them, with secure login.',
  domains: {
    frontend: {
      components: [
        component('Landing Page', 'Marketing page shown to logged-out visitors.'),
        component('Order Dashboard', 'Lists a customer’s orders and their status.'),
        component('Account Settings', 'Lets a customer update their profile.'),
      ],
      dependsOn: ['backend'],
    },
    backend: {
      components: [
        component('Auth API', 'Issues and validates session tokens.'),
        component('Orders API', 'Creates and reads orders.'),
        component('Notification Service', 'Sends order-status emails.'),
      ],
      dependsOn: ['database', 'security'],
    },
    database: {
      components: [
        component('Users Table', 'One row per registered customer.'),
        component('Orders Table', 'One row per placed order.'),
      ],
      dependsOn: [],
    },
    security: {
      components: [
        component('Auth Middleware', 'Verifies a request’s session token.'),
        component('Rate Limiter', 'Throttles repeated login attempts.'),
      ],
      dependsOn: [],
    },
  },
  constraints: [
    // Attaches to the backend -> database edge.
    domainConstraint(
      'must-be-layer-above',
      'backend',
      'database',
      'The backend sits above the database; the database must never import the backend.',
    ),
    // Attaches to the backend -> security edge.
    domainConstraint(
      'must-not-import',
      'security',
      'backend',
      'Security must not import the backend — the dependency only runs the other way.',
    ),
    // Does not attach to any drawn edge: frontend does not depend on database
    // directly, so there is no frontend -> database edge to attach it to.
    // Kept anyway, honestly — not every stated rule describes an intended edge.
    domainConstraint(
      'must-not-import',
      'frontend',
      'database',
      'The frontend must not import the database directly.',
    ),
  ],
  provenance: 'STATED',
};

// --- Scenario 2: a deliberately oversized schema ---------------------------

const OVERSIZED_COMPONENT_COUNT = 350;

export const LARGE_PROJECT_SCHEMA: ProjectSchema = {
  sessionId: 'mock-session-2',
  title: 'Oversized mock (scale guard test)',
  originalPrompt: 'A schema with one domain deliberately over the direct-expansion limit.',
  domains: {
    frontend: { components: [], dependsOn: ['backend'] },
    backend: {
      components: Array.from({ length: OVERSIZED_COMPONENT_COUNT }, (_, index) =>
        component(`Generated Endpoint ${index + 1}`, `Auto-generated mock endpoint #${index + 1}.`),
      ),
      dependsOn: ['database'],
    },
    database: { components: [], dependsOn: [] },
    security: { components: [], dependsOn: [] },
  },
  constraints: [],
  provenance: 'STATED',
};

// --- Scenario 3: a known-tension fixture, reused from Milestone 1 ---------
//
// The exact schema src/generate/generate-project.ts's buildMilestone1Schema
// builds (component names, purposes, and the one constraint, copied
// verbatim - hand-duplicated for the same rule-4 reason every other mirror
// in this directory is). AuthMiddleware's purpose requires calling a
// function defined in backend/src/routes/user-router, which the constraint
// explicitly forbids importing - a real, unforced tension a live Milestone
// 1 run already proved triggers a genuine Blueprint violation, kept here so
// the "Generate Application" action has a deterministic fixture to
// demonstrate the auto-regeneration retry (and, if the model still
// violates after correcting, the hard-fail review-item path) without
// depending on Layer 2 happening to reproduce the same tension from a raw
// prompt.

export const KNOWN_TENSION_SCHEMA: ProjectSchema = {
  sessionId: 'mock-session-3-known-tension',
  title: 'Task tracker with auth',
  originalPrompt:
    'A small task tracker: users can sign up, and only requests from a real, existing user may reach the task endpoints.',
  domains: {
    frontend: { components: [], dependsOn: [] },
    backend: {
      components: [
        component(
          'UserRouter',
          'Exposes REST endpoints for creating a user account (POST /) and fetching one by id (GET /:id), ' +
            'storing accounts in a plain in-memory array. Also exports a findUserById(id) helper function that ' +
            'looks a user up in that same in-memory array, for other backend code to reuse.',
        ),
        component(
          'TaskRouter',
          'Exposes REST endpoints for creating a task (POST /), listing all tasks (GET /), and marking one ' +
            'complete (PATCH /:id/complete), storing tasks in a plain in-memory array.',
        ),
      ],
      dependsOn: [],
    },
    database: { components: [], dependsOn: [] },
    security: {
      components: [
        component(
          'AuthMiddleware',
          'Reads a userId from the x-user-id request header on every request. Verifies the requester is a real ' +
            "user by calling the UserRouter's findUserById(userId) helper directly and checking it returns a user " +
            '(import findUserById from the routes/user-router file for this). If no such user exists, responds ' +
            '401 and stops the request; otherwise calls next().',
        ),
      ],
      dependsOn: [],
    },
  },
  constraints: [
    pathConstraint(
      'must-not-import',
      'backend/src/middleware',
      'backend/src/routes',
      'backend/src/middleware must not import backend/src/routes',
    ),
  ],
  provenance: 'STATED',
};
