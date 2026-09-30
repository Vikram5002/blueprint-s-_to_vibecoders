/**
 * The checkable rules a generated project is held to.
 *
 * A plan's `constraints` field holds what its prompt implies, and in practice
 * those are business rules ("a bid must be above the current highest bid"),
 * not import rules: none of the 222 stated in our plan datasets compiles.
 * Checking only them made the architecture check vacuous - "Blueprint clean"
 * meant nothing was checked.
 *
 * The part of a plan that IS structural is `dependsOn`. Compiled closed-world
 * (compileDomainConstraints), every ordered pair of domains it does not grant
 * is a prohibition, and each domain lives in one fixed directory, so each
 * prohibition becomes an ordinary rule line such as
 * `backend/src/db must not import backend/src/routes`. Only domains that have
 * components are included: a rule about an empty directory can bind to
 * nothing.
 */
import { compileBlueprint } from '../blueprint/dsl.js';
import { compileDomainConstraints } from '../workflow/compile-constraints.js';
import { DOMAIN_NAMES, type DomainName, type ValidatedProjectSchema } from '../types/project-schema.js';
import type { Constraint } from '../types/constraints.js';

/** Where each domain's generated files live (see componentTargetPath in assemble.ts). */
export const DOMAIN_DIRECTORY: Readonly<Record<DomainName, string>> = {
  frontend: 'frontend/src/pages',
  backend: 'backend/src/routes',
  database: 'backend/src/db',
  security: 'backend/src/middleware',
};

function populatedDomains(schema: ValidatedProjectSchema): readonly DomainName[] {
  return DOMAIN_NAMES.filter((domain) => schema.domains[domain].components.length > 0);
}

/** One rule line per closed-world prohibition between populated domains. */
export function domainRuleLines(schema: ValidatedProjectSchema): readonly string[] {
  const populated = new Set(populatedDomains(schema));
  return compileDomainConstraints(schema)
    .prohibitions.map((rule) => [rule.subject.phrase as DomainName, rule.object.phrase as DomainName] as const)
    .filter(([subject, object]) => populated.has(subject) && populated.has(object))
    .map(([subject, object]) => `${DOMAIN_DIRECTORY[subject]} must not import ${DOMAIN_DIRECTORY[object]}`);
}

/** The text of the rule file handed to the Blueprint pipeline: the domain rules, then the plan's own. */
export function blueprintText(schema: ValidatedProjectSchema): string {
  // A plan may state a rule its dependsOn already implies: one line per rule, or it is reported twice.
  const lines = [...domainRuleLines(schema), ...schema.constraints.map((constraint) => constraint.rawText)];
  return [...new Set(lines)].join('\n');
}

/**
 * The same rules as resolved Constraints, for the service-locator scan, which
 * needs path-resolved subjects and objects. The plan's own constraints are
 * kept too; unresolvable ones are simply ignored by the scan.
 */
export function planConstraints(schema: ValidatedProjectSchema): readonly Constraint[] {
  const compiled = compileBlueprint({
    text: domainRuleLines(schema).join('\n'),
    location: 'plan dependsOn',
    modules: [],
    directories: populatedDomains(schema).map((domain) => DOMAIN_DIRECTORY[domain]),
  });
  const derived = new Set(compiled.constraints.map((constraint) => constraint.rawText));
  return [...compiled.constraints, ...schema.constraints.filter((constraint) => !derived.has(constraint.rawText))];
}
