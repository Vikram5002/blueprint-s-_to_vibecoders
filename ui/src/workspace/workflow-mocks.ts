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
