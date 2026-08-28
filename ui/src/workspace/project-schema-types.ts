/**
 * Mirrors src/types/project-schema.ts exactly, hand-duplicated for the same
 * rule-4 reason as verification-types.ts: ui/ must not import from src/
 * directly. `Constraint` itself is NOT re-duplicated a third time — it is
 * imported from verification-types.ts, a sibling file in this same
 * directory, which already mirrors src/types/constraints.ts. Do not add,
 * rename, or simplify anything here; this is the existing shape, copied.
 */

import type { Constraint } from './verification-types';

export interface Component {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
}

export type DomainName = 'frontend' | 'backend' | 'database' | 'security';

export const DOMAIN_NAMES: readonly DomainName[] = ['frontend', 'backend', 'database', 'security'];

export interface DomainSpec {
  readonly components: readonly Component[];
  readonly dependsOn: readonly DomainName[];
}

export interface ProjectSchema {
  readonly sessionId: string;
  readonly title: string;
  readonly originalPrompt: string;
  readonly domains: {
    readonly frontend: DomainSpec;
    readonly backend: DomainSpec;
    readonly database: DomainSpec;
    readonly security: DomainSpec;
  };
  readonly constraints: readonly Constraint[];
  readonly provenance: 'STATED';
}
