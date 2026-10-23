/**
 * The form check's fix loop (form-check.ts): every page with a problem is
 * regenerated once per round by the repair coder, told exactly which call
 * failed and what the API really offers; the project is rebuilt and checked
 * again, for at most MAX_FORM_FIX_ROUNDS (3). A regenerated page that breaks the
 * build is put back as it was - a working build is never traded for a form.
 */
import type { ValidatedProjectSchema } from '../types/project-schema.js';
import type { CompletionProvider } from '../llm/provider.js';
import type { LabelCache } from '../llm/cache.js';
import type { GeneratedFile } from './assemble.js';
import { runCommand } from './build-and-repair.js';
import { createComponentCodeGenerator, type PriorViolationContext } from './component-codegen.js';
import { runFormCheck, type FormCheckOptions, type FormCheckResult, type FormProblem } from './form-check.js';
import { findComponentByTargetPath, generateComponentFile, type GenerateProjectFailure } from './generate-project.js';
import { filesFailingBuild, writeProjectFiles, type RegenerationAttempt } from './verify-and-regenerate.js';

// Three: on the library app the second round left one call a single field name away from working.
export const MAX_FORM_FIX_ROUNDS = 3;

export type FormPhase = 'form-checking' | 'form-fixing';

/** What the job result reports: how many page calls were checked, how many work, and what is still wrong. */
export interface FormCheckSummary {
  readonly calls: number;
  readonly passed: number;
  readonly problems: readonly FormProblem[];
}

export interface FormRepairOptions {
  readonly schema: ValidatedProjectSchema;
  readonly llm: { readonly provider: CompletionProvider; readonly cache: LabelCache; readonly repairProvider?: CompletionProvider };
  readonly root: string;
  readonly files: readonly GeneratedFile[];
  readonly onPhase?: (phase: FormPhase) => void;
  readonly check?: FormCheckOptions;
}

export interface FormRepairResult {
  readonly files: readonly GeneratedFile[];
  readonly regenerationLog: readonly RegenerationAttempt[];
  readonly forms: FormCheckSummary;
}

const summary = (result: FormCheckResult): FormCheckSummary => ({ calls: result.calls.length, passed: result.passed, problems: result.problems });

/** The correction the repair coder is given for a page; exported so training data uses the exact same words. */
export function formContext(page: string, problems: readonly FormProblem[]): PriorViolationContext {
  if (page.startsWith('backend/')) {
    return {
      ruleText: 'Every route a page calls must answer a valid request without crashing.',
      explanation: `The built app was started and the pages' real requests were sent to this route file - ${problems.length} crashed it (HTTP 5xx).`,
      fixInstruction:
        'Write the complete corrected route file: each request below must succeed - read the fields it sends, store or ' +
        'return the data through the table functions you may import, and answer with JSON. Keep every route path and export.',
      evidence: problems.map((p) => ({ file: page, line: 1, snippet: p.message })),
    };
  }
  return {
    ruleText: "Every call a page makes must match a route the API offers and send exactly the fields that route reads.",
    explanation: `The built app was started and this page's calls were tried against the real API - ${problems.length} did not work.`,
    fixInstruction:
      'Write the complete corrected page: change each failing call to use a route the API offers, with exactly the field ' +
      'names that route reads, and keep a labelled input for every field a person must type. Keep the page’s purpose and exports.',
    evidence: problems.map((p) => ({ file: page, line: 1, snippet: p.message })),
  };
}

export async function checkFormsAndRepair(options: FormRepairOptions): Promise<
  { readonly ok: true; readonly value: FormRepairResult } | { readonly ok: false; readonly error: GenerateProjectFailure }
> {
  const { schema, root } = options;
  const onPhase = options.onPhase ?? ((): void => undefined);
  const generator = createComponentCodeGenerator({ provider: options.llm.repairProvider ?? options.llm.provider, cache: options.llm.cache, skipCache: true });
  let files = options.files;
  const log: RegenerationAttempt[] = [];

  onPhase('form-checking');
  let result = await runFormCheck(root, schema, files, options.check);
  for (let round = 0; result.problems.length > 0 && round < MAX_FORM_FIX_ROUNDS; round += 1) {
    onPhase('form-fixing');
    const before = files;
    const attempted: { page: string; context: PriorViolationContext; owner: NonNullable<ReturnType<typeof findComponentByTargetPath>> }[] = [];
    for (const page of [...new Set(result.problems.map((p) => p.page))]) {
      const owner = findComponentByTargetPath(schema, page);
      if (owner === null) continue;
      const context = formContext(page, result.problems.filter((p) => p.page === page));
      const regenerated = await generateComponentFile(generator, schema, owner.component, owner.domain, context, files);
      if (!regenerated.ok) return { ok: false, error: regenerated.error };
      files = files.map((f) => (f.path === page ? regenerated.value : f));
      attempted.push({ page, context, owner });
    }
    if (attempted.length === 0) break;
    await writeProjectFiles(root, files, false);
    let build = await runCommand('npm', ['run', 'build'], root);
    const reverted = new Set<string>();
    if (!build.ok) {
      // Put back only the rewritten pages the compiler names - one broken page
      // must not throw away the others (found live: 5 pages rewritten, one
      // failed to compile, and all 5 went back to placeholders).
      const failing = filesFailingBuild(build.output);
      for (const a of attempted) if (failing.has(a.page) || failing.size === 0) reverted.add(a.page);
      files = files.map((f) => (reverted.has(f.path) ? (before.find((b) => b.path === f.path) ?? f) : f));
      await writeProjectFiles(root, files, false);
      build = await runCommand('npm', ['run', 'build'], root);
      if (!build.ok) {
        // Still broken: put everything back and stop - a working build is never traded for a form.
        files = before;
        await writeProjectFiles(root, files, false);
        await runCommand('npm', ['run', 'build'], root);
        log.push(...attempted.map((a) => ({ component: a.owner.component, domain: a.owner.domain, targetPath: a.page, firstAttemptViolation: a.context, origin: 'form-check' as const, outcome: 'still-violating' as const })));
        break;
      }
    }
    onPhase('form-checking');
    result = await runFormCheck(root, schema, files, options.check);
    const failing = new Set(result.problems.map((p) => p.page));
    log.push(...attempted.map((a) => ({
      component: a.owner.component,
      domain: a.owner.domain,
      targetPath: a.page,
      firstAttemptViolation: a.context,
      origin: 'form-check' as const,
      outcome: failing.has(a.page) || reverted.has(a.page) ? ('still-violating' as const) : ('fixed' as const),
    })));
  }
  return { ok: true, value: { files, regenerationLog: log, forms: summary(result) } };
}
