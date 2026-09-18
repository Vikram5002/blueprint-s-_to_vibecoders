/**
 * npm install, npm run build, then the build-failure repair loop - the
 * part of a Layer 3 job that comes after `generateAndVerifyProject` has put
 * files on disk and before the job reports.
 *
 * Lifted out of `server/generation-api.ts` unchanged in behaviour, so that
 * the training-data capture and evaluation scripts for the local code model
 * (docs/LOCAL-CODE-MODEL-PLAN.md, scripts/capture-code-batch.mjs and
 * scripts/eval-code-model.mjs) run exactly what the server runs - the same
 * commands, the same number of repair rounds, the same attribution - rather
 * than a re-implementation that could drift. The HTTP job's only concern
 * that stayed behind is progress reporting, which here is an `onPhase`
 * callback instead of a job-store write.
 */
import { spawn } from 'node:child_process';
import type { ValidatedProjectSchema } from '../types/project-schema.js';
import type { CompletionProvider } from '../llm/provider.js';
import type { LabelCache } from '../llm/cache.js';
import type { GeneratedFile } from './assemble.js';
import type { GenerateProjectFailure } from './generate-project.js';
import { filesFailingBuild, regenerateForBuildFailure, type RegenerationAttempt } from './verify-and-regenerate.js';

/** Build-failure repair passes per job - each regenerates every component file tsc still names, then rebuilds. */
export const MAX_BUILD_FIX_ROUNDS = 2;

/** Trimmed to keep a failed job's payload bounded - a full npm log can run to tens of KB, and only the tail is ever the actionable part. */
export const MAX_FAILURE_OUTPUT_CHARS = 4_000;

export type BuildPhase = 'installing' | 'building' | 'build-regenerating' | 'build-reverifying';

export interface FileSummary {
  readonly path: string;
  readonly bytes: number;
}

export interface BuildOutcome {
  readonly installOk: boolean;
  readonly buildOk: boolean;
  /** Last ~4000 chars of combined stdout+stderr for whichever step failed first. Never populated on a clean pass. */
  readonly failureOutput?: string;
}

export interface BuildStepResult {
  readonly files: readonly GeneratedFile[];
  readonly regenerationLog: readonly RegenerationAttempt[];
  readonly build: BuildOutcome;
}

export interface CommandResult {
  readonly ok: boolean;
  /** Tail of combined stdout+stderr, capped at MAX_FAILURE_OUTPUT_CHARS. */
  readonly output: string;
}

export interface InstallBuildAndRepairOptions {
  readonly schema: ValidatedProjectSchema;
  readonly llm: { readonly provider: CompletionProvider; readonly cache: LabelCache };
  /** The generated project's directory - where npm runs and where regenerated files are written. */
  readonly root: string;
  /** The project's files as currently on disk under `root`; the returned files are these with every repaired file replaced. */
  readonly files: readonly GeneratedFile[];
  /** A person's own words about what to change - passed through to every repaired file. See GenerateAndVerifyOptions.repairInstruction. */
  readonly instruction?: string;
  readonly onPhase?: (phase: BuildPhase) => void;
}

export function runCommand(command: string, args: readonly string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, { cwd, shell: true });
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (code) => resolve({ ok: code === 0, output: output.slice(-MAX_FAILURE_OUTPUT_CHARS) }));
    child.on('error', (cause) => resolve({ ok: false, output: String(cause) }));
  });
}

export function summarise(files: readonly GeneratedFile[]): FileSummary[] {
  return files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.contents, 'utf8') }));
}

/**
 * npm install, npm run build, then up to MAX_BUILD_FIX_ROUNDS repair passes:
 * fixing a file's syntax errors often only then exposes its type errors,
 * and correcting a dependency can surface a mismatch in its consumer, so
 * one pass is routinely not enough. Shared by a fresh generation and a
 * repair of a saved run - the only difference between the two is where the
 * files came from.
 */
export async function installBuildAndRepair(
  options: InstallBuildAndRepairOptions,
): Promise<{ readonly ok: true; readonly value: BuildStepResult } | { readonly ok: false; readonly error: GenerateProjectFailure }> {
  const { schema, llm, root, instruction } = options;
  const onPhase = options.onPhase ?? ((): void => undefined);

  onPhase('installing');
  const install = await runCommand('npm', ['install', '--no-audit', '--no-fund'], root);

  let build: CommandResult = { ok: false, output: '' };
  if (install.ok) {
    onPhase('building');
    build = await runCommand('npm', ['run', 'build'], root);
  }

  let files = options.files;
  let regenerationLog: RegenerationAttempt[] = [];

  for (let round = 0; install.ok && !build.ok && round < MAX_BUILD_FIX_ROUNDS; round += 1) {
    onPhase('build-regenerating');
    const buildRetry = await regenerateForBuildFailure(
      schema,
      {
        provider: llm.provider,
        cache: llm.cache,
        skipCache: true,
        root,
        ...(instruction === undefined ? {} : { repairInstruction: instruction }),
      },
      files,
      build.output,
    );
    if (!buildRetry.ok) {
      return { ok: false, error: buildRetry.error };
    }
    // Nothing attributable to a component (a config-level error, or only the
    // templated entry point named) - never guess; report the build failure.
    if (buildRetry.value.attempted.length === 0) break;

    files = buildRetry.value.files;
    onPhase('build-reverifying');
    const rebuild = await runCommand('npm', ['run', 'build'], root);
    const stillFailing = filesFailingBuild(rebuild.output);
    regenerationLog = [
      ...regenerationLog,
      ...buildRetry.value.attempted.map((attempt) => ({
        ...attempt,
        origin: 'build-failure' as const,
        outcome: rebuild.ok || !stillFailing.has(attempt.targetPath) ? ('fixed' as const) : ('still-violating' as const),
      })),
    ];
    build = rebuild;
  }

  return {
    ok: true,
    value: {
      files,
      regenerationLog,
      build: {
        installOk: install.ok,
        buildOk: install.ok && build.ok,
        ...(install.ok && build.ok ? {} : { failureOutput: install.ok ? build.output : install.output }),
      },
    },
  };
}
