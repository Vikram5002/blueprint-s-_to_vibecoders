/**
 * Mirrors src/server/workflow-api.ts's job types and src/workflow/
 * generate-project-schema.ts's `GenerateFailure`, hand-duplicated for the
 * same rule-4 reason as verification-types.ts and project-schema-types.ts:
 * ui/ must not import from src/ directly. Only the fields this package
 * actually reads are mirrored — `GenerateFailure`'s `rejections` array
 * (ProjectSchemaRejection[]) is real on the wire but nothing here inspects
 * it, so it is typed as `unknown` rather than fully mirrored a third time.
 *
 * `WorkflowPermission` mirrors src/workflow/compile-constraints.ts's type of
 * the same name. Present on the real API response but not currently read by
 * anything in this package — `deriveEdges` draws permitted edges from the
 * schema's own `dependsOn` arrays, the same source `compileDomainConstraints`
 * itself compiles permissions from, so the two are redundant for rendering
 * purposes. Mirrored anyway so the response shape is fully typed, not
 * partially ignored.
 *
 * Do not add fields here beyond what the real types have, and do not rename
 * anything — same discipline verification-types.ts documents for itself.
 */

import type { Constraint, ConstraintSource } from './verification-types';
import type { DomainName, ProjectSchema } from './project-schema-types';

export type WorkflowJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface WorkflowPermission {
  readonly subjectDomain: DomainName;
  readonly objectDomain: DomainName;
  readonly source: ConstraintSource;
}

export interface WorkflowJobResult {
  readonly schema: ProjectSchema;
  readonly prohibitions: readonly Constraint[];
  readonly permissions: readonly WorkflowPermission[];
}

export type GenerateFailureReason = 'provider-error' | 'unparseable-json' | 'schema-violation';

export type WorkflowJobError =
  | {
      readonly phase: 'generate';
      readonly reason: GenerateFailureReason;
      readonly message: string;
      readonly rejections?: unknown;
    }
  | { readonly phase: 'compile'; readonly message: string };

export interface WorkflowJob {
  readonly id: string;
  readonly prompt: string;
  readonly createdAt: string;
  readonly status: WorkflowJobStatus;
  readonly result?: WorkflowJobResult;
  readonly error?: WorkflowJobError;
}
