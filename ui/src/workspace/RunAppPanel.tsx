/**
 * "Run app": starts a run's generated application on this machine (the same
 * files as its zip) and shows it live inside the workspace, so the app can be
 * clicked through without downloading or unzipping anything.
 *
 * The server does the work (src/server/app-preview.ts) - this only starts,
 * polls and stops it. One app runs at a time; leaving the run stops nothing,
 * so "Stop app" (or closing VibeCoder) is what ends it.
 */
import { useEffect, useRef, useState } from 'react';
import { fetchAppPreview, startAppPreview, stopAppPreview, type AppPreviewStatus } from './workflow-api-client';
import { Icon } from '../design/Icon';

const POLL_MS = 1_500;

const STEP_LABEL: Record<NonNullable<AppPreviewStatus['step']>, string> = {
  install: 'Installing packages (the first run takes a minute)…',
  build: 'Building the backend…',
  start: 'Starting the app…',
};

export function RunAppPanel({ jobId }: { readonly jobId: string }): JSX.Element {
  const [status, setStatus] = useState<AppPreviewStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const alive = useRef(true);

  // Picks up an app already running for this run (after a page switch).
  useEffect(() => {
    alive.current = true;
    setStatus(null);
    setError(null);
    fetchAppPreview(jobId)
      .then((current) => alive.current && setStatus(current))
      .catch(() => undefined);
    return () => {
      alive.current = false;
    };
  }, [jobId]);

  useEffect(() => {
    if (status?.state !== 'starting') return undefined;
    const timer = setTimeout(() => {
      fetchAppPreview(jobId)
        .then((next) => alive.current && setStatus(next))
        .catch((cause: unknown) => alive.current && setError(String(cause instanceof Error ? cause.message : cause)));
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [jobId, status]);

  async function act(call: (id: string) => Promise<AppPreviewStatus>): Promise<void> {
    setError(null);
    try {
      const next = await call(jobId);
      if (alive.current) setStatus(next);
    } catch (cause) {
      if (alive.current) setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  const state = status?.state ?? 'stopped';
  const problem = error ?? status?.error;
  return (
    <div data-testid="run-app" className="rounded-xl border border-emerald-400/20 bg-emerald-500/[0.04] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <div className="text-xs font-semibold text-emerald-300">See the app working</div>
          <p className="text-[11px] text-slate-400">
            Runs this app on your computer and opens it here - no download needed. It starts with an empty database.
          </p>
        </div>
        {state === 'running' && status?.url !== undefined && (
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setReloadKey((key) => key + 1)}>
              Reload
            </button>
            <a href={status.url} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm" data-testid="run-app-open">
              <Icon name="external" size={13} />
              Open in browser
            </a>
          </>
        )}
        {state === 'starting' || state === 'running' ? (
          <button type="button" data-testid="run-app-stop" className="btn btn-secondary btn-sm" onClick={() => void act(stopAppPreview)}>
            <Icon name="stop" size={13} />
            Stop app
          </button>
        ) : (
          <button type="button" data-testid="run-app-start" className="btn btn-primary btn-sm" onClick={() => void act(startAppPreview)}>
            <Icon name="play" size={13} />
            {state === 'failed' ? 'Try again' : 'Run app'}
          </button>
        )}
      </div>

      {state === 'starting' && (
        <p data-testid="run-app-progress" className="mt-2 text-[11px] text-slate-300">
          {STEP_LABEL[status?.step ?? 'install']}
        </p>
      )}
      {problem !== undefined && problem !== null && (
        <details className="mt-2 rounded-lg border border-red-700/50 bg-red-950/20 p-2" open>
          <summary className="cursor-pointer text-xs font-medium text-red-300">The app could not start</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[11px] text-red-200">{problem}</pre>
        </details>
      )}
      {state === 'running' && status?.url !== undefined && (
        <iframe
          key={reloadKey}
          data-testid="run-app-frame"
          title="Generated app"
          src={status.url}
          className="mt-3 h-[560px] w-full rounded-lg border border-white/10 bg-white"
        />
      )}
    </div>
  );
}
