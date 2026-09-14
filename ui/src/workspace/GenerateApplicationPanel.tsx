import { useEffect, useRef, useState } from 'react';
import { applicationJobDownloadUrl, generateApplicationViaApi } from './workflow-api-client';
import type { ApplicationJob, ApplicationJobError, GenerationPhase } from './application-job-types';
import type { ProjectSchema } from './project-schema-types';

/**
 * The final milestone's real UI surface: turns an already-generated
 * ProjectSchema (live or mock) into a real generated, assembled, installed,
 * built, and Blueprint-verified application via
 * /api/workflow/application-jobs (src/server/generation-api.ts), which
 * wraps src/generate/verify-and-regenerate.ts - the same pipeline
 * Milestones 1-3 proved end-to-end from scripts, now reachable from a
 * button a real person can click.
 *
 * Every outcome is shown as it actually is - a hard-failed component is
 * rendered as a hard failure with its real evidence, never folded into a
 * generic "done" state. See Milestone 4's Task 1.4: "Do NOT hide or
 * simplify the retry/failure reporting to make the UI look cleaner."
 */

type PanelState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'in-flight'; readonly phase?: GenerationPhase | 'installing' | 'building' }
  | { readonly kind: 'done'; readonly job: ApplicationJob }
  | { readonly kind: 'error'; readonly message: string };

const PHASE_LABEL: Readonly<Record<GenerationPhase | 'installing' | 'building', string>> = {
  generating: 'Generating component files…',
  verifying: 'Verifying with Blueprint…',
  regenerating: 'Correcting a violating component…',
  reverifying: 'Re-verifying the correction…',
  installing: 'Running npm install…',
  building: 'Running npm run build…',
};

export function GenerateApplicationPanel({
  schema,
}: {
  readonly schema: ProjectSchema;
}): JSX.Element {
  const [state, setState] = useState<PanelState>({ kind: 'idle' });
  const [elapsedMs, setElapsedMs] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (state.kind !== 'in-flight') return;
    const startedAt = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
    return () => clearInterval(timer);
  }, [state.kind]);

  // Resets to idle whenever a different schema is shown (a new live
  // generation, or a different mock scenario) - a stale result from the
  // previous schema must never linger under a newly-shown graph.
  useEffect(() => {
    abortRef.current?.abort();
    setState({ kind: 'idle' });
  }, [schema.sessionId]);

  async function handleGenerate(): Promise<void> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ kind: 'in-flight' });
    try {
      const job = await generateApplicationViaApi(schema, {
        signal: controller.signal,
        onStatus: (j) => {
          if (j.status === 'pending' || j.status === 'running') {
            setState(
              j.phase === undefined ? { kind: 'in-flight' } : { kind: 'in-flight', phase: j.phase },
            );
          }
        },
      });
      setState({ kind: 'done', job });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  return (
    <div className="border-t border-slate-800 bg-slate-950 p-4">
      {state.kind !== 'in-flight' && (
        <button
          type="button"
          onClick={() => void handleGenerate()}
          className="rounded-lg border border-emerald-700 bg-emerald-950/30 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-900/40"
        >
          Generate Application
        </button>
      )}

      {state.kind === 'in-flight' && (
        <div className="flex items-center gap-3 text-sm text-slate-300">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-600 border-t-emerald-400" />
          <span>{state.phase !== undefined ? PHASE_LABEL[state.phase] : 'Queued…'}</span>
          <span className="text-xs text-slate-500">({(elapsedMs / 1000).toFixed(1)}s elapsed)</span>
        </div>
      )}

      {state.kind === 'error' && (
        <div className="mt-3 rounded-lg border border-red-700/50 bg-red-950/20 p-3 text-sm">
          <div className="mb-1 font-semibold text-red-300">Application generation failed</div>
          <p className="text-red-200">{state.message}</p>
        </div>
      )}

      {state.kind === 'done' && <ApplicationJobReport job={state.job} />}
    </div>
  );
}

function ApplicationJobReport({ job }: { readonly job: ApplicationJob }): JSX.Element {
  if (job.status === 'failed') {
    return (
      <div className="mt-3 rounded-lg border border-red-700/50 bg-red-950/20 p-3 text-sm">
        <div className="mb-1 font-semibold text-red-300">Application generation failed</div>
        {describeApplicationJobError(job.error)}
      </div>
    );
  }

  const result = job.result;
  if (result === undefined) {
    // Contract violation, same defensive posture WorkflowDemo.tsx's
    // applyFinishedJob already takes for the schema-generation job.
    return (
      <div className="mt-3 rounded-lg border border-amber-700/50 bg-amber-950/20 p-3 text-sm text-amber-200">
        Job {job.id} reached status &apos;succeeded&apos; without a result payload.
      </div>
    );
  }

  const hasUnresolved = result.unresolvedViolations.length > 0;
  const hasUnresolvedLocatorFindings = result.unresolvedServiceLocatorFindings.length > 0;

  return (
    <div className="mt-3 space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          ok={result.build.installOk}
          okLabel="npm install: passed"
          failLabel="npm install: failed"
        />
        <Badge
          ok={result.build.buildOk}
          okLabel="npm run build: passed"
          failLabel="npm run build: failed"
        />
        <Badge
          ok={!hasUnresolved}
          okLabel="Blueprint: all constraints satisfied"
          failLabel={`Blueprint: ${result.unresolvedViolations.length} unresolved violation(s)`}
        />
        <Badge
          ok={!hasUnresolvedLocatorFindings}
          okLabel="No suspected auth-bypass patterns"
          failLabel={`${result.unresolvedServiceLocatorFindings.length} suspected auth-bypass finding(s)`}
        />
        <a
          href={applicationJobDownloadUrl(job.id)}
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-medium text-slate-100 hover:bg-slate-700"
        >
          Download generated project (.zip)
        </a>
      </div>

      {result.build.failureOutput !== undefined && (
        <details className="rounded-lg border border-red-700/50 bg-red-950/20 p-2">
          <summary className="cursor-pointer text-xs font-medium text-red-300">
            Build/install failure output
          </summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-[11px] text-red-200">
            {result.build.failureOutput}
          </pre>
        </details>
      )}

      {result.regenerationLog.length > 0 && (
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-2">
          <div className="mb-2 text-xs font-semibold text-slate-300">
            Auto-regeneration audit log ({result.regenerationLog.length} component(s) needed a
            retry)
          </div>
          <ul className="space-y-2">
            {result.regenerationLog.map((attempt, index) => (
              <li
                key={`${attempt.targetPath}-${index}`}
                className="rounded border border-slate-800 bg-slate-950 p-2"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={
                      attempt.outcome === 'fixed'
                        ? 'rounded border border-emerald-700 bg-emerald-950/40 px-1.5 py-0.5 text-[11px] text-emerald-300'
                        : 'rounded border border-red-700 bg-red-950/40 px-1.5 py-0.5 text-[11px] text-red-300'
                    }
                  >
                    {attempt.outcome === 'fixed'
                      ? 'FIXED on retry'
                      : 'STILL VIOLATING — review item'}
                  </span>
                  <span className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[11px] text-slate-400">
                    {attempt.origin === 'blueprint-violation'
                      ? 'Blueprint violation'
                      : 'suspected auth-bypass pattern'}
                  </span>
                  <span className="font-medium text-slate-200">
                    {attempt.component.name} ({attempt.domain})
                  </span>
                  <span className="text-slate-500">{attempt.targetPath}</span>
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  Rule violated: {attempt.firstAttemptViolation.ruleText}
                </div>
                <div className="text-xs text-slate-500">
                  {attempt.firstAttemptViolation.explanation}
                </div>
                {attempt.firstAttemptViolation.evidence.map((e, i) => (
                  <div
                    key={i}
                    className="mt-1 rounded bg-black/30 px-2 py-1 font-mono text-[11px] text-amber-200"
                  >
                    {e.file}:{e.line}: {e.snippet}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasUnresolved && (
        <div className="rounded-lg border border-red-700/50 bg-red-950/20 p-2">
          <div className="mb-2 text-xs font-semibold text-red-300">
            Unresolved violations — {result.unresolvedViolations.length} review item(s), not
            auto-fixable
          </div>
          <ul className="space-y-2">
            {result.unresolvedViolations.map((violation) => (
              <li key={violation.id} className="rounded border border-red-900 bg-black/20 p-2">
                <div className="text-xs font-medium text-red-200">
                  {violation.kind} ({violation.severity}) — {violation.constraint.rawText}
                </div>
                <div className="text-xs text-red-300">{violation.explanation}</div>
                {violation.edges
                  .flatMap((edge) => edge.evidence)
                  .map((e, i) => (
                    <div
                      key={i}
                      className="mt-1 rounded bg-black/30 px-2 py-1 font-mono text-[11px] text-amber-200"
                    >
                      {e.file}:{e.line}: {e.snippet}
                    </div>
                  ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasUnresolvedLocatorFindings && (
        <div className="rounded-lg border border-amber-700/50 bg-amber-950/20 p-2">
          <div className="mb-2 text-xs font-semibold text-amber-300">
            Suspected auth-bypass patterns — {result.unresolvedServiceLocatorFindings.length} review
            item(s), NOT a Blueprint violation
          </div>
          <p className="mb-2 text-xs text-amber-400">
            No forbidden import edge exists here — Blueprint reports these files clean. This is a
            narrower, separate signal: a real, forbidden export was found referenced through a
            runtime lookup instead of a static import, which is exactly the auth-bypass pattern
            documented in docs/GENERATION.md. Always reviewed by hand, never auto-fixable with
            certainty.
          </p>
          <ul className="space-y-2">
            {result.unresolvedServiceLocatorFindings.map((finding, index) => (
              <li
                key={`${finding.file}-${index}`}
                className="rounded border border-amber-900 bg-black/20 p-2"
              >
                <div className="text-xs font-medium text-amber-200">
                  Rule possibly evaded: {finding.constraint.rawText}
                </div>
                <div className="text-xs text-amber-300">
                  Looked up &apos;{finding.lookupKey}&apos;, a real export of{' '}
                  {finding.matchedExportFile}
                </div>
                <div className="mt-1 rounded bg-black/30 px-2 py-1 font-mono text-[11px] text-amber-200">
                  {finding.file}:{finding.line}: {finding.snippet}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="rounded-lg border border-slate-800 bg-slate-900/30 p-2">
        <summary className="cursor-pointer text-xs font-medium text-slate-400">
          {result.files.length} generated file(s)
        </summary>
        <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-slate-400">
          {result.files.map((file) => (
            <li key={file.path}>
              {file.path} ({file.bytes} bytes)
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function Badge({
  ok,
  okLabel,
  failLabel,
}: {
  readonly ok: boolean;
  readonly okLabel: string;
  readonly failLabel: string;
}): JSX.Element {
  return (
    <span
      className={
        ok
          ? 'rounded-lg border border-emerald-700 bg-emerald-950/30 px-2 py-1 text-xs text-emerald-300'
          : 'rounded-lg border border-red-700 bg-red-950/30 px-2 py-1 text-xs text-red-300'
      }
    >
      {ok ? okLabel : failLabel}
    </span>
  );
}

/**
 * Renders the real shape of a `generate-application` failure - see
 * `ApplicationJobError`'s own doc comment for why this cannot just read
 * `error.message`. A component-generation failure names the real component
 * and domain that failed and the provider's own reason/message; a pipeline
 * failure carries only its own message. Never falls back to a generic
 * placeholder for a shape this function does not recognize - an
 * unrecognized error is shown as exactly that, not silently hidden.
 */
function describeApplicationJobError(error: ApplicationJobError | undefined): JSX.Element {
  if (error === undefined) {
    return <p className="text-red-200">(no error detail was sent by the server)</p>;
  }
  if ('component' in error) {
    return (
      <div className="text-red-200">
        <p>
          Component <span className="font-medium">{error.component.name}</span> ({error.domain})
          failed to generate: {error.failure.reason}
        </p>
        <p className="mt-1 text-xs text-red-300">{error.failure.message}</p>
      </div>
    );
  }
  return <p className="text-red-200">{error.message}</p>;
}
