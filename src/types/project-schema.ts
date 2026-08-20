/**
 * The output shape of the AI-Driven Application Builder's generation step.
 *
 * This is the first piece of that layer to exist as code. Everything above it
 * (Type-1/Type-2 in docs/BLUEPRINT.md) answers "what does this repository's
 * architecture look like, derived or stated?" ProjectSchema answers a
 * different, upstream question: "given a prompt describing an application
 * that does not exist yet, what is the proposed shape of it?" It is stated
 * intent about a project, in the same sense a blueprint constraint is stated
 * intent about an import rule — never derived, because there is no code yet
 * to derive it from.
 *
 * `constraints` reuses `Constraint` from `../types/constraints.js` exactly,
 * not a parallel type. A ProjectSchema's constraints are meant to become real
 * Type-1 blueprint constraints once code exists to check them against, so
 * they must already be shaped the way `check_import` and the conformance
 * pipeline expect. Redefining a look-alike type here would silently fork the
 * two the first time either one changed.
 */

import { createHash } from 'node:crypto';
import type { Constraint } from '../types/constraints.js';

/**
 * One unit of the proposed system: a page, a service, a table, an auth flow.
 * Deliberately shallow — this is a scaffold to hand to a builder agent, not a
 * full design doc. `purpose` is a sentence, not a spec.
 */
export interface Component {
  /** Content-derived: see componentId. Same domain+name+purpose always
   *  produces the same id, regardless of where it appears in the array —
   *  insertion order must never be load-bearing here, the same way
   *  Constraint.id must not depend on where in a document a sentence sits. */
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
}

/** Domain names ProjectSchema fixes to exactly these four. Not extensible per
 *  component — a fifth domain is a schema change, not a data value. */
export type DomainName = 'frontend' | 'backend' | 'database' | 'security';

export const DOMAIN_NAMES: readonly DomainName[] = ['frontend', 'backend', 'database', 'security'];

export interface DomainSpec {
  readonly components: readonly Component[];
  /** Other domain names this domain depends on, e.g. `frontend.dependsOn = ['backend']`.
   *  Deliberately just names, not Constraints — a domain-level dependency is a
   *  coarser, earlier-stage claim than an evaluable import rule between two
   *  named modules; it becomes a Constraint later, once real modules exist to
   *  resolve `subject`/`object` against. */
  readonly dependsOn: readonly DomainName[];
}

export interface ProjectSchema {
  readonly sessionId: string;
  readonly title: string;
  /** The user's prompt, verbatim. Never paraphrased — same rule as
   *  Constraint.rawText, and for the same reason: if generation drifted from
   *  what was actually asked for, the original has to still be there to
   *  compare against. */
  readonly originalPrompt: string;
  readonly domains: {
    readonly frontend: DomainSpec;
    readonly backend: DomainSpec;
    readonly database: DomainSpec;
    readonly security: DomainSpec;
  };
  readonly constraints: readonly Constraint[];
  /** Literal STATED, always — a ProjectSchema describes a system that does
   *  not exist yet, so nothing in it can ever be DERIVED. Same pattern as
   *  Constraint.provenance: typed as the literal so no code path can produce
   *  the other value. */
  readonly provenance: 'STATED';
}

/**
 * Content-derived, mirroring constraintId in src/conformance/compile.ts: the
 * same component (domain, name, purpose) always gets the same id, so two
 * generations of the same prompt produce comparable schemas rather than ones
 * that merely happen to look similar.
 */
export function componentId(domain: DomainName, name: string, purpose: string): string {
  return createHash('sha256')
    .update([domain, name.toLowerCase(), purpose].join(' '))
    .digest('hex')
    .slice(0, 16);
}
