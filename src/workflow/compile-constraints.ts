/**
 * Compiles a ProjectSchema's DomainSpec.dependsOn edges into a closed-world
 * set of Constraints and permissions.
 *
 * A ProjectSchema's dependsOn arrays name what a domain is allowed to depend
 * on, but say nothing explicit about what it is not allowed to depend on.
 * This module makes that silence explicit: for every ordered pair of
 * distinct domains, either dependsOn names the edge (a permission) or it
 * does not (a prohibition) — there is no third state. Rule 1's own name for
 * this is closed-world, and the point of it is that the prohibitions
 * outnumber the permissions in almost every real schema, and every one of
 * them is exactly as real a claim as the permissions dependsOn states
 * outright.
 *
 * Reuses `Constraint`, `ConstraintSource`, `ResolvedSubject` from
 * `../types/constraints.js` exactly — no parallel type. The one addition is
 * `'workflow-edge'` on `ConstraintSourceType`, a new source kind (not a new
 * Constraint shape) for a claim that comes from a schema's own dependsOn
 * array rather than from prose.
 *
 * ## Why permissions are not Constraints
 *
 * Every ConstraintRelation this project defines — must-not-import,
 * may-only-import-via, must-not-cycle, must-be-layer-above — is a
 * restriction. None of them state a plain, unconditional "A may depend on
 * B." Representing a permission as `must-not-import` would assert the exact
 * opposite of what is true, and extending ConstraintRelation with a new
 * permission-flavoured member would touch the same enum
 * src/conformance/violations.ts and src/mcp/check-import.ts both switch on
 * — the real verification engine, which this module does not touch.
 * Permissions are therefore returned as a separate, plainly-labelled
 * `WorkflowPermission[]`, never coerced into `Constraint`'s shape.
 *
 * ## Why prohibitions get confidence: 1
 *
 * `Constraint.confidence` exists to score prose extraction, where the model
 * might be wrong about what a sentence means (see docs/INTENT.md). There is
 * no such uncertainty here: whether B appears in A.dependsOn is a fact about
 * the schema's own JSON, checkable by looking at it, not a probabilistic
 * read of natural language. Every compiled prohibition is confidence: 1,
 * lowConfidence: false.
 */
import { createHash } from 'node:crypto';
import type { Constraint, ConstraintRelation, ConstraintSource, ResolvedSubject } from '../types/constraints.js';
import { DOMAIN_NAMES, type DomainName, type DomainSpec, type ValidatedProjectSchema } from '../types/project-schema.js';
import { validateProjectSchema } from './validate-project-schema.js';

/**
 * A permitted domain-to-domain dependency, compiled from DomainSpec.dependsOn.
 *
 * Deliberately not a Constraint — see this module's docstring. Carries the
 * same ConstraintSource every prohibition for the same pair would carry, so
 * a consumer can trace either outcome back to the same schema location.
 */
export interface WorkflowPermission {
  readonly subjectDomain: DomainName;
  readonly objectDomain: DomainName;
  readonly source: ConstraintSource;
}

export interface CompiledDomainConstraints {
  /** must-not-import Constraints for every ordered pair dependsOn does not name. */
  readonly prohibitions: readonly Constraint[];
  /** Every ordered pair dependsOn does name. */
  readonly permissions: readonly WorkflowPermission[];
}

const PROHIBITION_RELATION: ConstraintRelation = 'must-not-import';

/**
 * Compiles a validated ProjectSchema's dependsOn edges into the full
 * closed-world constraint set.
 *
 * Takes a ValidatedProjectSchema, not a plain ProjectSchema - compiler-
 * enforced, not conventional. The schema must have already passed
 * validateProjectSchema; there is no other way to produce this type (see
 * ValidatedProjectSchema's own doc comment in project-schema.ts). This
 * function's own tests already proved what malformed input does here
 * (nonexistent domains silently ignored, self-references silently
 * no-op'd, case-variant domain names compiled as unrelated ones) - the
 * brand exists so a caller cannot reach any of that by forgetting a
 * validation step, only by explicitly casting past the type system.
 *
 * Belt and braces: re-validates at runtime too, not just at the type
 * level. The brand only holds as long as nobody ever writes
 * `as unknown as ValidatedProjectSchema` to route around it - which
 * someone eventually will, under enough time pressure, the same way the
 * type-level guarantee alone was never going to stop the caller Option 1
 * worried about. Measured cost on this repo's largest real schema
 * (training/data/gold/gold.jsonl): ~1.89us, against this function's own
 * ~8.46us - cheaper than the compiler it guards, so there is no
 * meaningful-cost argument for skipping it on the common path.
 *
 * Iterates DOMAIN_NAMES in its own declared, fixed order (frontend, backend,
 * database, security) — not re-sorted independently, since that order is
 * already this codebase's one canonical domain ordering (the same order
 * validate-project-schema.ts and generate-project-schema.ts's JSON schema
 * both use). Pairs are emitted subject-major: every pair with frontend as
 * subject, in object order, then every pair with backend as subject, and so
 * on — 12 ordered pairs for the fixed 4 domains, deterministic and
 * documented, so the same ProjectSchema always compiles to a byte-identical
 * result.
 */
export function compileDomainConstraints(schema: ValidatedProjectSchema): CompiledDomainConstraints {
  const revalidated = validateProjectSchema(schema);
  if (!revalidated.ok) {
    throw new Error(
      'compileDomainConstraints: schema failed validateProjectSchema despite being typed ' +
        `ValidatedProjectSchema - reachable only via an explicit cast past the brand. ` +
        `${revalidated.error.length} rejection(s), starting with ` +
        `${revalidated.error[0]?.path}: ${revalidated.error[0]?.reason}`,
    );
  }

  return compileConstraintsForDomains(DOMAIN_NAMES, (domain) => schema.domains[domain]);
}

/**
 * The domain-count-parameterized core `compileDomainConstraints` calls with
 * the fixed DOMAIN_NAMES list.
 *
 * Exported mainly so the empty-output invariant below can be exercised
 * directly. A real ProjectSchema always supplies exactly DOMAIN_NAMES.length
 * (4) domains — the invariant can never legitimately fire through
 * compileDomainConstraints itself — so proving it actually throws requires
 * calling this with a domain list where "every ordered pair of distinct
 * domains" is genuinely empty, e.g. a single domain.
 */
export function compileConstraintsForDomains(
  domains: readonly DomainName[],
  domainSpecOf: (domain: DomainName) => DomainSpec,
): CompiledDomainConstraints {
  const prohibitions: Constraint[] = [];
  const permissions: WorkflowPermission[] = [];

  for (const subjectDomain of domains) {
    const dependsOn = domainSpecOf(subjectDomain).dependsOn;
    for (const objectDomain of domains) {
      if (subjectDomain === objectDomain) continue;

      const source: ConstraintSource = {
        type: 'workflow-edge',
        location: `domains.${subjectDomain}.dependsOn -> ${objectDomain}`,
        line: null,
        timestamp: null,
      };

      if (dependsOn.includes(objectDomain)) {
        permissions.push({ subjectDomain, objectDomain, source });
      } else {
        prohibitions.push(compileProhibition(subjectDomain, objectDomain, source));
      }
    }
  }

  // Rule 4's invariant: a non-empty domain list must never compile to
  // nothing. Under compileDomainConstraints's real 4-domain input this can
  // only fire from a bug in the loop above; called directly with a
  // single-domain list (see compile-constraints.test.ts) it fires because a
  // lone domain genuinely has no other distinct domain to pair with — this
  // module treats that as a case to refuse loudly, not one to return an
  // empty, easy-to-miss result for.
  if (domains.length > 0 && prohibitions.length + permissions.length === 0) {
    throw new Error(
      `compileDomainConstraints: ${domains.length} domain(s) given (${domains.join(', ')}) but compiled zero ` +
        'constraints. An empty result with a non-empty domain list is a bug, not a valid outcome.',
    );
  }

  return { prohibitions, permissions };
}

function compileProhibition(subjectDomain: DomainName, objectDomain: DomainName, source: ConstraintSource): Constraint {
  const subject = domainAsUnresolvedSubject(subjectDomain);
  const object = domainAsUnresolvedSubject(objectDomain);
  // Not quoted prose - there is none to quote. A mechanical, checkable
  // restatement of the schema fact this constraint came from, in the same
  // spirit rawText normally serves: something a reader can point at and
  // verify directly against the schema, here the dependsOn array itself
  // rather than a sentence.
  const rawText = `${subjectDomain} does not list "${objectDomain}" in domains.${subjectDomain}.dependsOn`;

  return {
    id: compiledConstraintId(PROHIBITION_RELATION, subjectDomain, objectDomain, rawText, source),
    relation: PROHIBITION_RELATION,
    subject,
    object,
    via: null,
    source,
    confidence: 1,
    lowConfidence: false,
    rawText,
    provenance: 'STATED',
  };
}

/**
 * A domain name is not a real code module, so it cannot resolve to one —
 * the same reasoning applies here as project-schema.ts documents for
 * generation-time constraints in general: there is no code yet to resolve
 * against. `origin` is left undefined rather than forced to 'prose': this
 * subject did not come from prose, and ResolvedSubject.origin is optional
 * precisely so a source that is neither 'prose' nor 'regex' can say so by
 * omitting it rather than picking the nearer-sounding wrong answer.
 */
function domainAsUnresolvedSubject(domain: DomainName): ResolvedSubject {
  return {
    phrase: domain,
    status: 'UNRESOLVED',
    target: null,
    reason: 'no-candidate',
    similarity: 0,
    alternatives: [],
  };
}

/**
 * Same content-derivation rule constraintId in src/conformance/compile.ts
 * follows, applied here rather than inventing a third id scheme: sha256 over
 * the fields that determine identity, NUL-joined so no combination of
 * variable-length fields can collide with a different combination, then
 * truncated to 16 hex characters — matching that function's own choices
 * exactly. Two compilations of the same schema must produce comparable, not
 * merely similar-looking, constraints.
 */
function compiledConstraintId(
  relation: ConstraintRelation,
  subjectPhrase: string,
  objectPhrase: string,
  rawText: string,
  source: ConstraintSource,
): string {
  return createHash('sha256')
    .update(
      [relation, subjectPhrase.toLowerCase(), objectPhrase.toLowerCase(), rawText, source.location, String(source.line)].join('\u0000'),
    )
    .digest('hex')
    .slice(0, 16);
}
