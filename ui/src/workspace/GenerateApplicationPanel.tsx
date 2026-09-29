import { useEffect, useRef, useState } from 'react';
import {
  applicationJobDownloadUrl,
  fetchRunPages,
  fetchSessionRuns,
  fetchWorkflowSession,
  generateApplicationViaApi,
  repairApplicationViaApi,
  continueApplicationViaApi,
  restoreRunPage,
  type RunPage,
} from './workflow-api-client';
import { useWorkspaceStore } from './store';
import { ComponentEditor } from './ComponentEditor';
import type { ApplicationJob, ApplicationJobError, GenerationPhase } from './application-job-types';
import type { ProjectSchema } from './project-schema-types';
import { Icon } from '../design/Icon';

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
 *
 * ## Saved runs
 *
 * A finished job is saved server-side against its session, so this panel
 * loads the session's latest run on mount - coming back to a session (from
 * the Sidebar, or from another tab) shows what was last generated, with its
 * download link, instead of an empty panel. Found live: every tab switch
 * lost the result, and the only way to see the zip again was to generate
 * again, paying for every file a second time.
 *
 * From a saved run whose build failed, "Fix build errors" starts a repair:
 * a new job from that run's files that regenerates only what tsc still
 * names - a handful of calls, not one per component. "Generate again" is
 * the full, costlier regeneration, labelled as such.
 */

type Phase =
  GenerationPhase | 'installing' | 'building' | 'build-regenerating' | 'build-reverifying';

type PanelState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'in-flight'; readonly action: 'generate' | 'repair' | 'continue'; readonly phase?: Phase }
  | { readonly kind: 'done'; readonly job: ApplicationJob; readonly restored: boolean }
  | { readonly kind: 'error'; readonly message: string };

/** What a download holds besides the code - src/export/project-pack.ts. */
export const PACK_NOTE = 'Includes docs/: a project report, how it works, API guide, viva questions and free hosting steps.';

const PHASE_LABEL: Readonly<Record<Phase, string>> = {
  generating: 'Generating component files…',
  verifying: 'Verifying with Blueprint…',
  regenerating: 'Correcting a violating component…',
  reverifying: 'Re-verifying the correction…',
  installing: 'Running npm install…',
  building: 'Running npm run build…',
  'build-regenerating': 'Correcting a build failure…',
  'build-reverifying': 'Re-running npm run build…',
};

const REPAIR_PHASE_LABEL: Partial<Record<Phase, string>> = {
  generating: 'Copying the saved run…',
  reverifying: 'Re-verifying with Blueprint…',
};

export function GenerateApplicationPanel({
  schema,
}: {
  readonly schema: ProjectSchema;
}): JSX.Element {
  const notifyRunSaved = useWorkspaceStore((state) => state.notifyRunSaved);
  const rememberSession = useWorkspaceStore((state) => state.rememberSession);
  const [state, setState] = useState<PanelState>({ kind: 'idle' });
  const [elapsedMs, setElapsedMs] = useState(0);
  const [instruction, setInstruction] = useState('');
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

  // Whenever a different schema is shown (a session opened, a new live
  // generation, a different mock scenario): drop anything from the previous
  // schema and load THIS session's last saved run, if it has one. A stale
  // result from another schema must never linger under a newly-shown graph.
  useEffect(() => {
    abortRef.current?.abort();
    setState({ kind: 'idle' });
    setInstruction('');
    let cancelled = false;
    fetchSessionRuns(schema.sessionId)
      .then((runs) => {
        if (cancelled || runs.latest === null) return;
        setState({ kind: 'done', job: runs.latest, restored: true });
      })
      .catch(() => {
        // No saved run is the normal case for a mock schema; a transport
        // failure here only means the panel starts empty, as it always did.
      });
    return () => {
      cancelled = true;
    };
  }, [schema.sessionId]);

  function trackProgress(action: 'generate' | 'repair' | 'continue'): (job: ApplicationJob) => void {
    return (j) => {
      if (j.status === 'pending' || j.status === 'running') {
        setState(j.phase === undefined ? { kind: 'in-flight', action } : { kind: 'in-flight', action, phase: j.phase });
      }
    };
  }

  async function handleGenerate(): Promise<void> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ kind: 'in-flight', action: 'generate' });
    try {
      const job = await generateApplicationViaApi(schema, { signal: controller.signal, onStatus: trackProgress('generate') });
      setState({ kind: 'done', job, restored: false });
      notifyRunSaved();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  async function handleRepair(jobId: string): Promise<void> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ kind: 'in-flight', action: 'repair' });
    try {
      const job = await repairApplicationViaApi(jobId, instruction, { signal: controller.signal, onStatus: trackProgress('repair') });
      setState({ kind: 'done', job, restored: false });
      setInstruction('');
      notifyRunSaved();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  async function handleContinue(jobId: string): Promise<void> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ kind: 'in-flight', action: 'continue' });
    try {
      const job = await continueApplicationViaApi(jobId, { signal: controller.signal, onStatus: trackProgress('continue') });
      setState({ kind: 'done', job, restored: false });
      notifyRunSaved();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  const totalComponents = (['frontend', 'backend', 'database', 'security'] as const).reduce(
    (count, domain) => count + schema.domains[domain].components.length,
    0,
  );
  const savedComponents = state.kind === 'done' ? (state.job.partialFiles?.length ?? 0) : 0;
  const canContinue = state.kind === 'done' && state.job.status === 'failed' && state.job.result === undefined && savedComponents > 0;

  const canRepair =
    state.kind === 'done' &&
    state.job.status === 'succeeded' &&
    state.job.result !== undefined &&
    state.job.result.build.installOk &&
    !state.job.result.build.buildOk;

  return (
    <div className="px-4 pb-8 pt-2">
      {state.kind !== 'in-flight' && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="generate-application"
            onClick={() => void handleGenerate()}
            className={`btn ${state.kind === 'done' ? 'btn-secondary btn-sm' : 'btn-primary'}`}
          >
            <Icon name={state.kind === 'done' ? 'history' : 'play'} size={13} className={state.kind === 'done' ? '' : 'fill-current'} />
            {state.kind === 'done' ? 'Generate again (full, uses tokens)' : 'Generate Application'}
          </button>
          {state.kind === 'done' && state.restored && (
            <span data-testid="restored-run-note" className="text-[11px] text-slate-500">
              Showing this session&apos;s last saved run ({state.job.kind === 'repair' ? 'repair' : state.job.kind === 'page-sync' ? 'page sync' : state.job.kind === 'continue' ? 'continued generation' : state.job.kind === 'import' ? 'imported project' : state.job.kind === 'edit' ? 'component edit' : 'generation'},{' '}
              {new Date(state.job.createdAt).toLocaleString()})
            </span>
          )}
        </div>
      )}

      {state.kind === 'in-flight' && (
        <div className="card flex items-center gap-3 !rounded-xl px-4 py-3 text-sm text-slate-200">
          <span className="spinner !h-[18px] !w-[18px]" />
          <span>
            {state.phase === undefined
              ? 'Queued…'
              : state.action === 'repair'
                ? (REPAIR_PHASE_LABEL[state.phase] ?? PHASE_LABEL[state.phase])
                : PHASE_LABEL[state.phase]}
          </span>
          <span className="text-xs text-slate-500">({(elapsedMs / 1000).toFixed(1)}s elapsed)</span>
        </div>
      )}

      {state.kind === 'error' && (
        <div className="mt-3 rounded-xl border border-red-400/25 bg-red-500/[0.07] p-3.5 text-sm">
          <div className="mb-1 font-semibold text-red-300">Application generation failed</div>
          <p className="text-red-200">{state.message}</p>
        </div>
      )}

      {canContinue && state.kind === 'done' && (
        <div data-testid="continue-panel" className="mt-3 rounded-xl border border-sky-400/20 bg-sky-500/[0.06] p-3.5">
          <div className="mb-1 text-xs font-semibold text-sky-300">
            This run stopped partway - {savedComponents} of {totalComponents} components were already written.
          </div>
          <p className="mb-2 text-[11px] text-sky-200/80">
            Continue from where it stopped: the saved components are kept as they are and only the rest are generated, then the project is
            built and verified as usual.
          </p>
          <button
            type="button"
            data-testid="continue-run"
            onClick={() => void handleContinue(state.job.id)}
            className="btn btn-primary btn-sm"
          >
            <Icon name="play" size={12} className="fill-current" />
            Continue generation ({totalComponents - savedComponents} left)
          </button>
        </div>
      )}

      {canRepair && state.kind === 'done' && (
        <div data-testid="repair-panel" className="mt-3 rounded-xl border border-amber-400/20 bg-amber-500/[0.06] p-3.5">
          <div className="mb-1 text-xs font-semibold text-amber-300">This run did not build. Fix it without regenerating everything?</div>
          <p className="mb-2 text-[11px] text-amber-200/80">
            Only the files the compiler still rejects are rewritten - a few model calls instead of one per component.
            Optionally say what to change:
          </p>
          <div className="flex flex-wrap items-start gap-2">
            <textarea
              data-testid="repair-instruction"
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="e.g. keep the product list on the catalog page; the checkout form must post to /api/orders"
              rows={2}
              className="focus-glow min-w-[280px] flex-1 rounded-lg border border-white/[0.08] bg-black/25 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
            />
            <button
              type="button"
              data-testid="repair-run"
              onClick={() => void handleRepair(state.job.id)}
              className="btn btn-secondary btn-sm"
            >
              <Icon name="wand" size={13} />
              Fix build errors
            </button>
          </div>
        </div>
      )}

      {state.kind === 'done' && state.job.status === 'succeeded' && state.job.result !== undefined && (
        <ComponentEditor
          job={state.job}
          schema={schema}
          onDone={(finished) => {
            setState({ kind: 'done', job: finished, restored: false });
            notifyRunSaved();
            // The plan changed server-side; show it in the graph too.
            fetchWorkflowSession(schema.sessionId).then(rememberSession).catch(() => {});
          }}
        />
      )}

      {state.kind === 'done' && <ApplicationJobReport job={state.job} schema={schema} />}
    </div>
  );
}

function ApplicationJobReport({ job, schema }: { readonly job: ApplicationJob; readonly schema: ProjectSchema }): JSX.Element {
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
          data-testid="download-zip"
          title={PACK_NOTE}
          className="btn btn-primary btn-sm ml-auto"
        >
          <Icon name="download" size={13} />
          Download generated project (.zip)
        </a>
        <span className="basis-full text-right text-[11px] text-slate-500">{PACK_NOTE}</span>
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

      <RunPages job={job} schema={schema} />

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
                      : attempt.origin === 'service-locator-evasion'
                        ? 'suspected auth-bypass pattern'
                        : 'npm run build failure'}
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

/**
 * The run's frontend pages, each openable in the Page Builder. The server
 * turns the model's JSX into a canvas layout (or returns the last saved
 * edit), and a save from the builder writes the page's real file back into
 * this run - so the zip download reflects the edit. A saved edit replaces
 * the model's page with the static design; "Restore original" puts the
 * model's file back.
 */
function RunPages({ job, schema }: { readonly job: ApplicationJob; readonly schema: ProjectSchema }): JSX.Element | null {
  const openPageInBuilder = useWorkspaceStore((state) => state.openPageInBuilder);
  const runsVersion = useWorkspaceStore((state) => state.runsVersion);
  const [pages, setPages] = useState<readonly RunPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRunPages(job.id)
      .then((list) => {
        if (!cancelled) setPages(list);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [job.id, runsVersion]);

  async function handleRestore(path: string): Promise<void> {
    try {
      await restoreRunPage(job.id, path);
      setPages(await fetchRunPages(job.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (error !== null) {
    return <div className="text-[11px] text-red-300">Could not list this run&apos;s pages: {error}</div>;
  }
  if (pages === null || pages.length === 0) return null;

  return (
    <div data-testid="run-pages" className="rounded-lg border border-slate-700 bg-slate-900/50 p-2">
      <div className="mb-1 text-xs font-semibold text-slate-300">Pages ({pages.length}) — open one in the Page Builder to edit its UI</div>
      <p className="mb-2 text-[11px] text-slate-500">
        Saving from the builder replaces that page&apos;s file with your design in this run&apos;s zip. Restore original undoes it.
      </p>
      <ul className="space-y-1">
        {pages.map((page) => (
          <li key={page.path} className="flex flex-wrap items-center gap-2 rounded border border-slate-800 bg-slate-950 px-2 py-1">
            <span className="font-medium text-slate-200">{page.pageName}</span>
            <span className="font-mono text-[11px] text-slate-500">{page.path}</span>
            <span className="text-[11px] text-slate-500">{page.layout.elements.length} element(s)</span>
            {page.edited && (
              <span className="rounded border border-sky-800 bg-sky-950/40 px-1.5 py-0.5 text-[10px] text-sky-300">edited in Page Builder</span>
            )}
            <button
              type="button"
              data-testid={`edit-page-${page.path}`}
              onClick={() =>
                openPageInBuilder(
                  { runId: job.id, sessionId: job.sessionId, sessionTitle: schema.title, path: page.path, edited: page.edited },
                  page.layout,
                )
              }
              className="ml-auto rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-slate-800"
            >
              Edit in Page Builder
            </button>
            {page.edited && (
              <button
                type="button"
                onClick={() => void handleRestore(page.path)}
                className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-400 hover:bg-slate-800"
              >
                Restore original
              </button>
            )}
          </li>
        ))}
      </ul>
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
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
        ok ? 'bg-emerald-500/[0.09] text-emerald-300 ring-emerald-400/20' : 'bg-red-500/[0.1] text-red-300 ring-red-400/25'
      }`}
    >
      <Icon name={ok ? 'check' : 'x'} size={12} strokeWidth={2.4} />
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
