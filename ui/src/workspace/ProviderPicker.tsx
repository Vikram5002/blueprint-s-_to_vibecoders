import { useEffect, useState } from 'react';
import { fetchProviders, updateProviders } from './provider-api-client';
import type { ProviderName, ProviderStatus } from './provider-types';

type State =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly current: ProviderName;
      readonly codeProvider: ProviderName | null;
      readonly localBaseUrl: string;
      readonly providers: readonly ProviderStatus[];
    }
  /** The routes are mounted unconditionally, so a failure here is a real transport problem - not "no provider configured", which is a normal state the ready view reports properly. */
  | { readonly kind: 'error'; readonly message: string };

/**
 * Which model answers generation requests - a cloud API, or a fine-tuned
 * checkpoint served over HTTP.
 *
 * Lives in the shell's tab strip rather than inside the Workflow tab because
 * the choice is not scoped to one view: it decides who serves schema
 * generation (Workflow graph) AND the real application generation that
 * follows it. Availability is shown but never enforced - you can select a
 * local model before starting its server, and the picker tells you it is not
 * up rather than refusing the choice, because a probe result is a snapshot,
 * not a permanent fact about your machine.
 *
 * The origin field appears only for `local`, and exists because that server
 * is not always on loopback: a 7B checkpoint needs more VRAM than some
 * machines have, so it legitimately runs on another machine or a free cloud
 * GPU reached through a tunnel - and a tunnel hands out a new hostname every
 * session, which is exactly the thing that must not require editing a
 * dotfile and restarting the server.
 */
export function ProviderPicker(): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchProviders()
      .then((response) => {
        if (cancelled) return;
        setState({
          kind: 'ready',
          current: response.current,
          codeProvider: response.codeProvider ?? null,
          localBaseUrl: response.localBaseUrl,
          providers: response.providers,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function apply(update: {
    readonly provider?: ProviderName;
    readonly localBaseUrl?: string;
    readonly codeProvider?: ProviderName | 'same';
  }): Promise<void> {
    setBusy(true);
    setUrlError(null);
    try {
      const response = await updateProviders(update);
      setState({
        kind: 'ready',
        current: response.current,
        codeProvider: response.codeProvider ?? null,
        localBaseUrl: response.localBaseUrl,
        providers: response.providers,
      });
      setUrlDraft(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A rejected URL is a correctable typo, not a broken picker - keep the
      // picker usable and report it next to the field it came from.
      if (update.localBaseUrl !== undefined) setUrlError(message);
      else setState({ kind: 'error', message });
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === 'loading') {
    return <span className="text-[11px] text-slate-500">Model…</span>;
  }

  if (state.kind === 'error') {
    return <span className="text-[11px] text-red-300">Model: {state.message}</span>;
  }

  const active = state.providers.find((entry) => entry.id === state.current);
  const showUrlField = state.current === 'local';
  const draft = urlDraft ?? state.localBaseUrl;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="whitespace-nowrap text-[11px] uppercase tracking-wide text-slate-500">Model</span>
      <select
        data-testid="provider-select"
        value={state.current}
        disabled={busy}
        onChange={(event) => void apply({ provider: event.target.value as ProviderName })}
        className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 disabled:opacity-60"
      >
        {state.providers.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
            {entry.available ? '' : ' — unavailable'}
          </option>
        ))}
      </select>

      <span className="whitespace-nowrap text-[11px] uppercase tracking-wide text-slate-500">Code</span>
      <select
        data-testid="code-provider-select"
        value={state.codeProvider ?? 'same'}
        disabled={busy}
        onChange={(event) => void apply({ codeProvider: event.target.value as ProviderName | 'same' })}
        title="Which model writes the application's code on Generate Application. The plan is still made by Model."
        className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 disabled:opacity-60"
      >
        <option value="same">Same as Model</option>
        {state.providers.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
            {entry.available ? '' : ' — unavailable'}
          </option>
        ))}
      </select>

      {showUrlField ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            void apply({ localBaseUrl: draft });
          }}
        >
          <input
            type="text"
            data-testid="local-base-url"
            value={draft}
            disabled={busy}
            onChange={(event) => setUrlDraft(event.target.value)}
            placeholder="https://your-tunnel.trycloudflare.com"
            title="Where the local inference server is reachable. Paste a new tunnel URL here each Colab session."
            className="w-48 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 disabled:opacity-60"
          />
          <button
            type="submit"
            data-testid="local-base-url-apply"
            disabled={busy || draft === state.localBaseUrl}
            className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            {busy ? '…' : 'Connect'}
          </button>
        </form>
      ) : null}

      {urlError !== null ? (
        <span data-testid="provider-url-error" className="max-w-[240px] truncate text-[11px] text-red-300">
          {urlError}
        </span>
      ) : (
        active !== undefined && (
          <span
            data-testid="provider-detail"
            title={`${active.model} — ${active.detail}`}
            className={`max-w-[160px] truncate text-[11px] ${active.available ? 'text-slate-500' : 'text-amber-300'}`}
          >
            {active.available ? active.model : active.detail}
          </span>
        )
      )}
    </div>
  );
}
