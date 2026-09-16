/**
 * Mirrors src/store/workflow-sessions-store.ts's WorkflowSessionSummary/
 * WorkflowSessionDetail, hand-duplicated for the same rule-4 reason every
 * other mirror file in this directory documents for itself: ui/ must not
 * import from src/ directly. Do not add fields here beyond what the real
 * types have, and do not rename anything.
 */

import type { WorkflowPermission } from './workflow-job-types';
import type { Constraint } from './verification-types';
import type { ProjectSchema } from './project-schema-types';

export interface WorkflowSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly createdAt: string;
}

export interface WorkflowSessionDetail extends WorkflowSessionSummary {
  readonly schema: ProjectSchema;
  readonly prohibitions: readonly Constraint[];
  readonly permissions: readonly WorkflowPermission[];
}
