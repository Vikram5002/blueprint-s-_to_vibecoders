/**
 * Mirrors src/server/generation-api.ts's job types, hand-duplicated for the
 * same rule-4 reason as workflow-job-types.ts and verification-types.ts:
 * ui/ must not import from src/ directly. `Violation` is imported from
 * verification-types.ts rather than re-duplicated a third time - same
 * pattern workflow-job-types.ts already uses for `Constraint`.
 *
 * `Component` and `DomainName` come from project-schema-types.ts -
 * `RegenerationAttempt` on the wire carries a real `Component` and
 * `DomainName`, mirrored there already.
 *
 * Do not add fields here beyond what the real types have, and do not rename
 * anything — same discipline every other mirror file in this directory
 * documents for itself.
 */

import type { Violation } from './verification-types';
import type { Component, DomainName } from './project-schema-types';

export type ApplicationJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type GenerationPhase = 'generating' | 'verifying' | 'regenerating' | 'reverifying';

export interface FileSummary {
  readonly path: string;
  readonly bytes: number;
}

export interface PriorViolationContext {
  readonly ruleText: string;
  readonly explanation: string;
  readonly evidence: readonly {
    readonly file: string;
    readonly line: number;
    readonly snippet: string;
  }[];
}

export interface RegenerationAttempt {
  readonly component: Component;
  readonly domain: DomainName;
  readonly targetPath: string;
  readonly firstAttemptViolation: PriorViolationContext;
  readonly outcome: 'fixed' | 'still-violating';
}

export interface BuildOutcome {
  readonly installOk: boolean;
  readonly buildOk: boolean;
  readonly failureOutput?: string;
}

export interface ApplicationJobResult {
  readonly files: readonly FileSummary[];
  readonly regenerationLog: readonly RegenerationAttempt[];
  readonly unresolvedViolations: readonly Violation[];
  readonly build: BuildOutcome;
}

/**
 * Mirrors src/generate/generate-project.ts's `GenerateProjectFailure` and
 * src/generate/component-codegen.ts's `ComponentCodeFailure` exactly -
 * `{ phase: 'generate-application' }` on the wire is NOT a flat
 * `{ message }` object; it is `GenerateAndVerifyFailure`
 * (src/generate/verify-and-regenerate.ts), a union of "one component's
 * generation call itself failed" (carries `component`/`domain`/`failure`,
 * no top-level `message`) and "the Blueprint pipeline errored" (carries
 * `reason: 'pipeline-error'` and `message`). A prior version of this file
 * assumed the wrong flat shape and silently rendered "(no message)" for
 * every real component-generation failure - found by Milestone 4's own
 * live browser test.
 */
export interface ComponentCodeFailure {
  readonly reason: string;
  readonly message: string;
  readonly retryable?: boolean;
}

export type ApplicationJobError =
  | {
      readonly phase: 'generate-application';
      readonly component: Component;
      readonly domain: DomainName;
      readonly failure: ComponentCodeFailure;
    }
  | {
      readonly phase: 'generate-application';
      readonly reason: 'pipeline-error';
      readonly message: string;
    }
  | { readonly phase: 'unexpected'; readonly message: string };

export interface ApplicationJob {
  readonly id: string;
  readonly createdAt: string;
  readonly status: ApplicationJobStatus;
  readonly phase?: GenerationPhase | 'installing' | 'building';
  readonly result?: ApplicationJobResult;
  readonly error?: ApplicationJobError;
}
