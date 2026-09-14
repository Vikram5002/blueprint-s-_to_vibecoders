/**
 * Layer 3, Milestone 3: the auto-regeneration retry, approved back in
 * Milestone 1's design proposal and deferred twice since.
 *
 * The loop is exactly the shape §4 proposed: generate, write to disk, run
 * the existing, unmodified Blueprint pipeline against the real output, and
 * if a violation is attributable to one specific generated file, feed that
 * violation's real evidence back into exactly that component's generation
 * prompt as corrective context, then regenerate only that component - never
 * the whole project - and re-verify. One retry per component, ever. A
 * component that still violates after its one retry is a hard-failed
 * review item, not a silent loop and not a softened constraint: the
 * constraint is never touched, only the code is ever asked to change.
 *
 * This module is the one place that writes generated files to disk and
 * calls into `pipeline/run.ts` - `generate-project.ts` stays pure
 * (schema in, files out, no filesystem, no Blueprint), the same separation
 * `assemble.ts` (templating) and `component-codegen.ts` (one LLM call) each
 * already keep.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Component, DomainName, ValidatedProjectSchema } from '../types/project-schema.js';
import type { ViolatingEdge, Violation } from '../types/violations.js';
import { err, ok, type Result } from '../types/result.js';
import { runPipeline, type RunOptions } from '../pipeline/run.js';
import {
  createComponentCodeGenerator,
  type PriorViolationContext,
  type CreateComponentCodeGeneratorOptions,
} from './component-codegen.js';
import {
  findComponentByTargetPath,
  generateComponentFile,
  generateProject,
  type GenerateProjectFailure,
} from './generate-project.js';
import type { GeneratedFile } from './assemble.js';

export interface RegenerationAttempt {
  readonly component: Component;
  readonly domain: DomainName;
  readonly targetPath: string;
  /** The real violation the first attempt produced - never paraphrased. */
  readonly firstAttemptViolation: PriorViolationContext;
  /** 'fixed': the same file/constraint pair no longer appears in the re-run. 'still-violating': hard-failed, kept as the last attempt's content. */
  readonly outcome: 'fixed' | 'still-violating';
}

export interface GenerateAndVerifyResult {
  readonly files: readonly GeneratedFile[];
  /** One entry per component that needed a retry, in the order retries were attempted. Empty means every component passed on the first attempt. */
  readonly regenerationLog: readonly RegenerationAttempt[];
  /**
   * Violations still present after every eligible retry ran - either a
   * component that violated twice (see regenerationLog for which), or a
   * violation Blueprint found that could not be attributed to any single
   * generated component's file in the first place (e.g. a cycle spanning
   * several files), which is never eligible for this loop's kind of retry.
   */
  readonly unresolvedViolations: readonly Violation[];
}

export type GenerateAndVerifyFailure =
  | GenerateProjectFailure
  | { readonly reason: 'pipeline-error'; readonly message: string };

/**
 * Coarse-grained phase reporting for a caller with a real progress UI (the
 * server's application-generation job, surfaced in the Workflow UI) -
 * everything this function actually does, in the order it does it.
 * `regenerating`/`reverifying` are only ever reported when the first check
 * found at least one attributable violation; a project that passes on the
 * first attempt goes straight from `verifying` to done.
 */
export type GenerationPhase = 'generating' | 'verifying' | 'regenerating' | 'reverifying';

export interface GenerateAndVerifyOptions extends CreateComponentCodeGeneratorOptions {
  /** Directory the project is written to and verified in. Cleared and recreated on every call. */
  readonly root: string;
  readonly onPhase?: (phase: GenerationPhase) => void;
}

/**
 * Writes every generated file under `root`. `clean` wipes the directory
 * first - used only for the very first write, so a stale file from an
 * earlier, unrelated run can never survive into a Blueprint check. The
 * retry pass writes with `clean: false`: wiping the whole directory again
 * would also delete the blueprint DSL file this loop wrote alongside the
 * project (never regenerated on retry, since the schema's constraints
 * never change) and risks colliding with Blueprint's own `.vibe/` SQLite
 * database from the first run, whose WAL files are not always released
 * instantly on Windows the moment `db.close()` returns.
 */
async function writeProjectFiles(root: string, files: readonly GeneratedFile[], clean: boolean): Promise<void> {
  if (clean) {
    await rm(root, { recursive: true, force: true });
  }
  for (const file of files) {
    const fullPath = join(root, ...file.path.split('/'));
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, file.contents, 'utf8');
  }
}

const BLUEPRINT_FILE_NAME = 'generated.blueprint';

/**
 * Every constraint's own `rawText` is already the exact DSL line that would
 * compile back to it (Milestone 1/2's fixtures are built this way - see
 * `compileBlueprint` call sites in generate-project.ts) - so recompiling
 * through the same `--blueprint` file path `runPipeline` already supports
 * is how this loop hands the schema's constraints to the UNMODIFIED
 * Blueprint pipeline, rather than inventing a second way to inject them.
 */
async function writeBlueprintFile(root: string, schema: ValidatedProjectSchema): Promise<string> {
  const path = join(root, BLUEPRINT_FILE_NAME);
  const text = schema.constraints.map((constraint) => constraint.rawText).join('\n');
  await writeFile(path, `${text}\n`, 'utf8');
  return path;
}

async function verify(root: string, blueprintFile: string): Promise<Result<readonly Violation[], { readonly reason: 'pipeline-error'; readonly message: string }>> {
  const run = await runPipeline({ root, blueprintFile } satisfies RunOptions);
  if (!run.ok) {
    return err({ reason: 'pipeline-error', message: run.error.message });
  }
  run.value.db.close();
  return ok(run.value.conformance.violations);
}

/**
 * Turns one Blueprint violation's edges into the exact corrective context
 * component-codegen.ts's prompt needs - real rule text, real explanation,
 * real evidence lines, all copied from what Blueprint actually found, never
 * re-derived or summarised.
 *
 * Takes an explicit edge subset, not the whole violation: `Violation.edges`
 * is "every edge that breaks this constraint" (see types/violations.ts) -
 * one Violation object can bundle edges from SEVERAL different offending
 * files when they all break the same rule (three independent routers each
 * importing their own database file is one Violation with three edges, not
 * three). Passing the whole violation here would tell one component's
 * regeneration about a different component's offending line entirely -
 * confusing corrective context at best, and this function is the one place
 * that must not do that.
 */
function toPriorViolationContext(violation: Violation, edges: readonly ViolatingEdge[]): PriorViolationContext {
  return {
    ruleText: violation.constraint.rawText,
    explanation: violation.explanation,
    evidence: edges.flatMap((edge) => edge.evidence.map((e) => ({ file: e.file, line: e.line, snippet: e.snippet }))),
  };
}

/**
 * Groups every violation's edges by the file that actually contains the
 * offending import - the real per-component attribution this loop needs.
 * Grouping by file rather than by whole Violation is what makes multiple
 * independently-offending components under one constraint each get their
 * own retry: without it, a single Violation bundling three files' edges
 * would only ever surface (and only ever fix) whichever file happened to be
 * first. A `cycle` violation has no single "from" file by construction
 * (`edges` names every link in the loop) and is never attributed here - it
 * is returned separately, as unattributable.
 */
function groupEdgesByFile(
  violations: readonly Violation[],
): { readonly byFile: ReadonlyMap<string, { readonly violation: Violation; readonly edges: ViolatingEdge[] }>; readonly unattributable: readonly Violation[] } {
  const byFile = new Map<string, { violation: Violation; edges: ViolatingEdge[] }>();
  const unattributable: Violation[] = [];

  for (const violation of violations) {
    if (violation.kind === 'cycle' || violation.edges.length === 0) {
      unattributable.push(violation);
      continue;
    }
    for (const edge of violation.edges) {
      const existing = byFile.get(edge.fromFile);
      if (existing !== undefined) {
        existing.edges.push(edge);
      } else {
        byFile.set(edge.fromFile, { violation, edges: [edge] });
      }
    }
  }

  return { byFile, unattributable };
}

/** Every distinct file named as an offending edge's source, across every violation - used to decide what still violates after a retry pass. */
function filesStillViolating(violations: readonly Violation[]): ReadonlySet<string> {
  const files = new Set<string>();
  for (const violation of violations) {
    if (violation.kind === 'cycle') continue;
    for (const edge of violation.edges) files.add(edge.fromFile);
  }
  return files;
}

/**
 * Generates a full project, writes it to disk, verifies it with the real
 * Blueprint pipeline, and - for every violation traceable to one specific
 * generated file - regenerates that one component exactly once with the
 * real violation evidence as corrective context, then re-verifies the
 * whole project one more time. Never more than one retry per component,
 * per the approved design; a component still violating after its retry is
 * reported in `unresolvedViolations`, not retried again, and its
 * constraint is never relaxed to make the finding disappear.
 */
export async function generateAndVerifyProject(
  schema: ValidatedProjectSchema,
  options: GenerateAndVerifyOptions,
): Promise<Result<GenerateAndVerifyResult, GenerateAndVerifyFailure>> {
  options.onPhase?.('generating');
  const generated = await generateProject(schema, options);
  if (!generated.ok) return err(generated.error);

  await writeProjectFiles(options.root, generated.value.files, true);
  const blueprintFile = await writeBlueprintFile(options.root, schema);

  options.onPhase?.('verifying');
  const firstCheck = await verify(options.root, blueprintFile);
  if (!firstCheck.ok) return err(firstCheck.error);

  if (firstCheck.value.length === 0) {
    return ok({ files: generated.value.files, regenerationLog: [], unresolvedViolations: [] });
  }

  // One retry candidate per offending FILE, not per Violation object - see
  // groupEdgesByFile's own docstring for why those are not the same thing.
  const { byFile, unattributable: firstPassUnattributable } = groupEdgesByFile(firstCheck.value);

  options.onPhase?.('regenerating');
  const generator = createComponentCodeGenerator(options);
  let files = generated.value.files;
  const attempts: { readonly component: Component; readonly domain: DomainName; readonly targetPath: string; readonly firstAttemptViolation: PriorViolationContext }[] = [];
  const unattributable: Violation[] = [...firstPassUnattributable];

  for (const [targetPath, { violation, edges }] of byFile) {
    const owner = findComponentByTargetPath(schema, targetPath);
    if (owner === null) {
      // The violating file is not a component this loop can regenerate (a
      // templated entry point, for instance) - report it as unresolved
      // rather than guess at what to change.
      unattributable.push(violation);
      continue;
    }

    const firstAttemptViolation = toPriorViolationContext(violation, edges);
    const regenerated = await generateComponentFile(generator, schema, owner.component, owner.domain, firstAttemptViolation, files);
    if (!regenerated.ok) return err(regenerated.error);

    files = files.map((f) => (f.path === targetPath ? regenerated.value : f));
    attempts.push({ component: owner.component, domain: owner.domain, targetPath, firstAttemptViolation });
  }

  if (attempts.length === 0) {
    // Every violation was unattributable - nothing to retry.
    return ok({ files, regenerationLog: [], unresolvedViolations: unattributable });
  }

  await writeProjectFiles(options.root, files, false);
  options.onPhase?.('reverifying');
  const secondCheck = await verify(options.root, blueprintFile);
  if (!secondCheck.ok) return err(secondCheck.error);

  const stillViolatingFiles = filesStillViolating(secondCheck.value);

  const regenerationLog: RegenerationAttempt[] = attempts.map((attempt) => ({
    ...attempt,
    outcome: stillViolatingFiles.has(attempt.targetPath) ? 'still-violating' : 'fixed',
  }));

  const attemptedPaths = new Set(attempts.map((attempt) => attempt.targetPath));
  const unresolvedViolations = [
    ...unattributable,
    // Only a violation touching a file this loop actually retried and that
    // still shows up counts as "unresolved" here - a file that was never
    // attributed at all in the first place is already in `unattributable`,
    // and re-including it via a blanket "still present" check would
    // double-count it.
    ...secondCheck.value.filter((violation) =>
      violation.kind !== 'cycle' && violation.edges.some((edge) => attemptedPaths.has(edge.fromFile)),
    ),
  ];

  return ok({ files, regenerationLog, unresolvedViolations });
}
