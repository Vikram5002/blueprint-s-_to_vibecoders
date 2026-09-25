/**
 * Per-file acceptance for code-model training data (docs/GPU-COMPUTE-PROPOSAL.md, A1).
 *
 * The first capture judged a project as a whole: one file tsc rejected made
 * every file in the project a rejected example, including files that compiled,
 * respected every import rule and answered their routes. On the 14B teacher's
 * first batch that discarded 6 of 7 projects outright (2026-09-25).
 *
 * Here a file is rejected only for what can be pinned on that file:
 *
 *   - tsc named it (the generated project builds with ONE `tsc` over every
 *     file, so a file tsc did not name really did compile);
 *   - a violating import edge starts in it (`fromFile` - the forbidden target
 *     is not at fault);
 *   - a service-locator finding sits in it;
 *   - its own route check failed, or could not run because the build failed.
 *
 * Anything that cannot be attributed rejects every file, never guessed:
 * a failed install, a failed build with no parsable diagnostics or with
 * output cut at the cap (a file might be missing from the tail only because
 * of the cut), a violation with no edges, a server that never started.
 */
import type { SuspectedServiceLocatorEvasion } from './detect-service-locator-evasion.js';
import type { ComponentRouteResult } from './runtime-check.js';
import { parseTscDiagnostics } from './verify-and-regenerate.js';

export type FileRejectionReason =
  | 'install-failed'
  | 'build-failed'
  | 'blueprint-violation'
  | 'service-locator-finding'
  | 'runtime-not-started'
  | 'runtime-not-checked'
  | 'runtime-route-failed';

/** A Blueprint violation, or the capture script's `pipeline-error` stand-in; only the edges matter here. */
export interface AttributableViolation {
  readonly edges?: readonly { readonly fromFile: string }[];
}

export interface FileAcceptanceInput {
  readonly installOk: boolean;
  readonly buildOk: boolean;
  /** The failed build's output tail; ignored when the build passed. */
  readonly buildOutput: string;
  /** True when `buildOutput` hit the capture cap and may be missing diagnostics. */
  readonly buildOutputTruncated: boolean;
  readonly violations: readonly AttributableViolation[];
  readonly locatorFindings: readonly Pick<SuspectedServiceLocatorEvasion, 'file'>[];
  /** Whether the server came up; ignored when the build failed (it was never started). */
  readonly runtimeStarted: boolean;
  readonly routeResults: readonly Pick<ComponentRouteResult, 'targetPath' | 'passed'>[];
}

export function normalisePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Returns the rejection reasons for one file; an empty list means accepted. */
export function createFileJudge(input: FileAcceptanceInput): (targetPath: string) => readonly FileRejectionReason[] {
  const projectWide = projectWideReasons(input);
  const failingBuild = new Set(parseTscDiagnostics(input.buildOutput).map((d) => normalisePath(d.file)));
  const violating = new Set(input.violations.flatMap((v) => (v.edges ?? []).map((e) => normalisePath(e.fromFile))));
  const locator = new Set(input.locatorFindings.map((f) => normalisePath(f.file)));
  const routes = new Map(input.routeResults.map((r) => [normalisePath(r.targetPath), r.passed] as const));

  return (targetPath) => {
    if (projectWide.length > 0) return projectWide;
    const path = normalisePath(targetPath);
    const reasons: FileRejectionReason[] = [];
    if (!input.buildOk && failingBuild.has(path)) reasons.push('build-failed');
    if (violating.has(path)) reasons.push('blueprint-violation');
    if (locator.has(path)) reasons.push('service-locator-finding');
    const routePassed = routes.get(path);
    if (routePassed !== undefined && !input.buildOk) reasons.push('runtime-not-checked');
    else if (routePassed === false) reasons.push('runtime-route-failed');
    return reasons;
  };
}

function projectWideReasons(input: FileAcceptanceInput): readonly FileRejectionReason[] {
  if (!input.installOk) return ['install-failed'];
  const reasons: FileRejectionReason[] = [];
  if (!input.buildOk) {
    const unattributable = input.buildOutputTruncated || parseTscDiagnostics(input.buildOutput).length === 0;
    if (unattributable) reasons.push('build-failed');
  }
  if (input.violations.some((v) => (v.edges ?? []).length === 0)) reasons.push('blueprint-violation');
  if (input.buildOk && !input.runtimeStarted) reasons.push('runtime-not-started');
  return reasons;
}
