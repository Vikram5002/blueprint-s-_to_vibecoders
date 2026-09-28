import { useState } from 'react';
import { fetchApplicationJob, saveRunPage, syncRunPage, type SyncedField } from './workflow-api-client';
import { useWorkspaceStore, type PageOrigin } from './store';
import { FIELD_TYPES } from './page-builder-catalogue';
import type { CanvasElement } from './page-builder-types';
import type { ApplicationJob } from './application-job-types';

interface PageSyncButtonProps {
  readonly origin: PageOrigin;
  readonly pageName: string;
  readonly elements: readonly CanvasElement[];
}

type SyncState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly fields: readonly SyncedField[]; readonly phase: string }
  | { readonly kind: 'done'; readonly job: ApplicationJob; readonly fields: readonly SyncedField[] }
  | { readonly kind: 'error'; readonly message: string };

const POLL_MS = 2000;

/** The job's own reason, e.g. a provider's quota message - never a vaguer summary of it. */
function failureMessage(job: ApplicationJob): string {
  const error = job.error;
  if (error === undefined) return 'unknown error';
  if ('failure' in error) return `${error.component.name}: ${error.failure.message}`;
  return error.message;
}

/**
 * "Update backend & database": saves this page, then runs a page sync
 * (src/generate/page-sync.ts) - the page's form fields become a backend API
 * and a database table, generated, built and verified as a new run. On
 * success the canvas moves to that new run, so further edits and the zip
 * download include the new backend.
 */
export function PageSyncButton({ origin, pageName, elements }: PageSyncButtonProps): JSX.Element | null {
  const openPageInBuilder = useWorkspaceStore((state) => state.openPageInBuilder);
  const notifyRunSaved = useWorkspaceStore((state) => state.notifyRunSaved);
  const [state, setState] = useState<SyncState>({ kind: 'idle' });

  if (!elements.some((element) => FIELD_TYPES.has(element.type))) return null;

  async function waitFor(jobId: string, fields: readonly SyncedField[]): Promise<ApplicationJob> {
    for (;;) {
      const job = await fetchApplicationJob(jobId);
      if (job.status === 'succeeded' || job.status === 'failed') return job;
      setState({ kind: 'running', fields, phase: job.phase ?? job.status });
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  async function handleSync(): Promise<void> {
    setState({ kind: 'running', fields: [], phase: 'saving the page' });
    try {
      const theme = useWorkspaceStore.getState().pageBuilder.theme;
      const layout = { id: `${origin.runId}:${origin.path}`, pageName, elements, ...(theme === undefined ? {} : { theme }) };
      await saveRunPage(origin.runId, layout);
      const started = await syncRunPage(origin.runId, origin.path);
      const job = await waitFor(started.id, started.fields);
      notifyRunSaved();
      if (job.status === 'succeeded') openPageInBuilder({ ...origin, runId: job.id, edited: true }, layout);
      setState({ kind: 'done', job, fields: started.fields });
    } catch (cause) {
      setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  const build = state.kind === 'done' ? state.job.result?.build : undefined;
  return (
    <div className="flex w-full flex-wrap items-center gap-2 text-[11px]">
      <button
        type="button"
        data-testid="sync-backend"
        onClick={() => void handleSync()}
        disabled={state.kind === 'running'}
        title="Save this page, then generate a backend API and a database table for its form fields - built and verified as a new run"
        className="rounded border border-violet-700 bg-violet-950/40 px-2 py-1 font-medium text-violet-200 hover:bg-violet-900/40 disabled:opacity-50"
      >
        {state.kind === 'running' ? 'Updating backend & database…' : 'Update backend & database'}
      </button>
      {state.kind === 'running' && (
        <span data-testid="sync-status" className="text-slate-400">
          {state.phase}
          {state.fields.length > 0 && ` - fields: ${state.fields.map((f) => `${f.name} (${f.kind})`).join(', ')}`}
        </span>
      )}
      {state.kind === 'done' && state.job.status === 'succeeded' && (
        <span data-testid="sync-status" className={build?.buildOk === true ? 'text-emerald-300' : 'text-amber-300'}>
          {build?.buildOk === true ? 'Backend and database updated - the project builds. ' : 'Generated, but the build still fails - see the run in the Workflow tab. '}
          Stored fields: {state.fields.map((f) => f.name).join(', ')}.
        </span>
      )}
      {state.kind === 'done' && state.job.status === 'failed' && (
        <span data-testid="sync-status" className="text-red-300">
          Sync failed: {failureMessage(state.job)}
        </span>
      )}
      {state.kind === 'error' && (
        <span data-testid="sync-status" className="text-red-300">
          {state.message}
        </span>
      )}
    </div>
  );
}
