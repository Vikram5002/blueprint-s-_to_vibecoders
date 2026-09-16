import { useEffect, useState } from 'react';
import { fetchProviders, selectProvider } from './provider-api-client';
import type { ProviderName, ProviderStatus } from './provider-types';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly current: ProviderName; readonly providers: readonly ProviderStatus[] }
  /** The routes are mounted unconditionally, so a failure here is a real transport problem - not "no provider configured", which is a normal state the ready view reports properly. */
  | { readonly kind: 'error'; readonly message: string };

/**
 * Which model answers generation requests - a cloud API, or the fine-tuned
 * checkpoint running on this machine.
 *
 * Lives in the shell's tab strip rather than inside the Workflow tab because
 * the choice is not scoped to one view: it decides who serves schema
 * generation (Workflow graph) AND the real application generation that
 * follows it. Availability is shown but never enforced - you can select a
 * local model before starting its server, and the picker tells you it is not
 * up rather than refusing the choice, because a probe result is a snapshot,
 * not a permanent fact about your machine.
 */
export function ProviderPicker(): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchProviders()
      .then((response) => {
        if (cancelled) return;
        setState({ kind: 'ready', current: response.current, providers: response.providers });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleChange(provider: ProviderName): Promise<void> {
    setBusy(true);
    try {
      const response = await selectProvider(provider);
      setState({ kind: 'ready', current: response.current, providers: response.providers });
    } catch (cause) {
      setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
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

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="whitespace-nowrap text-[11px] uppercase tracking-wide text-slate-500">Model</span>
      <select
        data-testid="provider-select"
        value={state.current}
        disabled={busy}
        onChange={(event) => void handleChange(event.target.value as ProviderName)}
        className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 disabled:opacity-60"
      >
        {state.providers.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
            {entry.available ? '' : ' — unavailable'}
          </option>
        ))}
      </select>
      {active !== undefined && (
        <span
          data-testid="provider-detail"
          title={`${active.model} — ${active.detail}`}
          className={`max-w-[240px] truncate text-[11px] ${active.available ? 'text-slate-500' : 'text-amber-300'}`}
        >
          {active.available ? active.model : active.detail}
        </span>
      )}
    </div>
  );
}
