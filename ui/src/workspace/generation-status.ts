/**
 * Per-node generation status. Not part of ProjectSchema — the real schema
 * describes the proposed *shape* of a system, not the live state of
 * generating it. This is workspace-local UI state, mocked here the same way
 * everything else in this feature is mocked pending a real orchestrator.
 *
 * Six states, each meant to be visually distinct at a glance — sharing the
 * colour vocabulary already established elsewhere in this workspace rather
 * than inventing a new one: 'verified' and 'violation-detected' reuse
 * VerificationResultPanel's green/red exactly, since they describe the same
 * two outcomes for a domain's generated code that panel describes for one
 * artefact.
 */
export type GenerationStatus =
  | 'not-started'
  | 'layout-selected'
  | 'generating'
  | 'generated'
  | 'verified'
  | 'violation-detected';

export const GENERATION_STATUSES: readonly GenerationStatus[] = [
  'not-started',
  'layout-selected',
  'generating',
  'generated',
  'verified',
  'violation-detected',
];

export const GENERATION_STATUS_LABEL: Readonly<Record<GenerationStatus, string>> = {
  'not-started': 'Not started',
  'layout-selected': 'Layout selected',
  generating: 'Generating…',
  generated: 'Generated',
  verified: 'Verified',
  'violation-detected': 'Violation detected',
};
