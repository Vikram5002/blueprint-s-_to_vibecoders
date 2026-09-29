import { useEffect, useRef, useState } from 'react';
import { fetchProviders, updateProviders } from './provider-api-client';
import { Icon } from '../design/Icon';
import { useWorkspaceStore } from './store';
import type { ProviderName, ProviderStatus } from './provider-types';

type State =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly current: ProviderName;
      readonly codeProvider: ProviderName | null;
      readonly localBaseUrl: string;
      readonly localCodeBaseUrl: string;
      readonly providers: readonly ProviderStatus[];
    }
  /** The routes are mounted unconditionally, so a failure here is a real transport problem - not "no provider configured", which is a normal state the ready view reports properly. */
  | { readonly kind: 'error'; readonly message: string };

type Ready = Extract<State, { readonly kind: 'ready' }>;

interface Update {
  readonly provider?: ProviderName;
  readonly localBaseUrl?: string;
  readonly localCodeBaseUrl?: string;
  readonly codeProvider?: ProviderName | 'same';
}

/** "Groq (free tier, cloud)" -> "Groq": the chip has room for a name, the menu shows the rest. */
const shortLabel = (label: string): string => label.replace(/\s*\(.*\)\s*$/, '');

/**
 * Which models answer: who writes the plan (Model) and who writes the code
 * (Code) - a cloud API, a free service, or a fine-tuned checkpoint served
 * over HTTP.
 *
 * A compact chip in the header that opens a menu, because the full controls
 * (two pickers, and an address field for a local or tunnelled server) do not
 * fit beside the tabs on a laptop screen. Availability is shown but never
 * enforced: you can pick a model before starting its server, and the menu
 * says it is not up - with how to set it up for free - rather than refusing,
 * because a probe result is a snapshot, not a permanent fact.
 *
 * The address fields exist because a local server is not always on loopback:
 * it may be a free cloud GPU reached through a tunnel, which hands out a new
 * address every session - the thing that must not require editing a dotfile.
 */
export function ProviderPicker(): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [codeUrlDraft, setCodeUrlDraft] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const providersVersion = useWorkspaceStore((store) => store.providersVersion);

  useEffect(() => {
    let cancelled = false;
    fetchProviders()
      .then((response) => {
        if (!cancelled) setState(readyFrom(response));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [providersVersion]);

  // Outside click and Escape close the menu, like every menu people already know.
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function apply(update: Update): Promise<void> {
    setBusy(true);
    setUrlError(null);
    try {
      setState(readyFrom(await updateProviders(update)));
      setUrlDraft(null);
      setCodeUrlDraft(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A rejected URL is a correctable typo, not a broken picker - keep the
      // picker usable and report it next to the field it came from.
      if (update.localBaseUrl !== undefined || update.localCodeBaseUrl !== undefined) setUrlError(message);
      else setState({ kind: 'error', message });
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === 'loading') return <span className="skeleton h-7 w-36" aria-label="Loading models" />;
  if (state.kind === 'error') return <span className="max-w-[240px] truncate text-[11px] text-red-300">Models: {state.message}</span>;

  const plan = state.providers.find((entry) => entry.id === state.current);
  const code = state.codeProvider === null ? undefined : state.providers.find((entry) => entry.id === state.codeProvider);
  const allAvailable = (plan?.available ?? false) && (code?.available ?? true);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        data-testid="model-menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="Choose which AI plans and writes the code"
        className="btn btn-secondary btn-sm max-w-[280px] !gap-2 !pl-2.5"
      >
        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${allAvailable ? 'bg-emerald-400 shadow-[0_0_8px_rgba(48,209,88,0.7)]' : 'bg-amber-400 shadow-[0_0_8px_rgba(255,159,10,0.6)]'}`} />
        <Icon name="cpu" size={14} className="flex-shrink-0 text-slate-400" />
        <span className="min-w-0 truncate">
          {shortLabel(plan?.label ?? state.current)}
          {code !== undefined && <span className="text-slate-400"> · code: {shortLabel(code.label)}</span>}
        </span>
        <Icon name="chevron-down" size={13} className={`flex-shrink-0 text-slate-400 transition-transform duration-300 ease-apple ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <ModelMenu
          state={state}
          busy={busy}
          urlDraft={urlDraft ?? state.localBaseUrl}
          codeUrlDraft={codeUrlDraft ?? state.localCodeBaseUrl}
          urlError={urlError}
          onUrlDraft={setUrlDraft}
          onCodeUrlDraft={setCodeUrlDraft}
          apply={(update) => void apply(update)}
        />
      )}
    </div>
  );
}

function readyFrom(response: Awaited<ReturnType<typeof fetchProviders>>): Ready {
  return {
    kind: 'ready',
    current: response.current,
    codeProvider: response.codeProvider ?? null,
    localBaseUrl: response.localBaseUrl,
    localCodeBaseUrl: response.localCodeBaseUrl,
    providers: response.providers,
  };
}

interface ModelMenuProps {
  readonly state: Ready;
  readonly busy: boolean;
  readonly urlDraft: string;
  readonly codeUrlDraft: string;
  readonly urlError: string | null;
  readonly onUrlDraft: (value: string) => void;
  readonly onCodeUrlDraft: (value: string) => void;
  readonly apply: (update: Update) => void;
}

const SELECT_CLASS =
  'h-9 w-full rounded-[10px] border border-white/[0.09] bg-white/[0.05] pl-3 text-[13px] font-medium text-slate-100 hover:bg-white/[0.08] disabled:opacity-60';

function ModelMenu({ state, busy, urlDraft, codeUrlDraft, urlError, onUrlDraft, onCodeUrlDraft, apply }: ModelMenuProps): JSX.Element {
  const active = state.providers.find((entry) => entry.id === state.current);
  const code = state.codeProvider === null ? undefined : state.providers.find((entry) => entry.id === state.codeProvider);
  const options = state.providers.map((entry) => (
    <option key={entry.id} value={entry.id}>
      {entry.label}
      {entry.available ? '' : ' — not set up'}
    </option>
  ));

  return (
    <div
      role="dialog"
      aria-label="AI models"
      className="anim-pop absolute right-0 top-full z-50 mt-2 w-[min(390px,calc(100vw-24px))] rounded-2xl border border-white/[0.09] bg-[#17171a]/[0.97] p-4 shadow-[var(--shadow-pop)] backdrop-blur-2xl"
    >
      <div className="mb-3.5 flex items-baseline justify-between">
        <span className="text-sm font-semibold tracking-tight text-slate-50">AI models</span>
        <span className="text-[11px] text-slate-500">Free options are listed first</span>
      </div>

      <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-slate-500" htmlFor="provider-select">
        Plans the app
      </label>
      <select
        id="provider-select"
        data-testid="provider-select"
        value={state.current}
        disabled={busy}
        onChange={(event) => apply({ provider: event.target.value as ProviderName })}
        className={SELECT_CLASS}
      >
        {options}
      </select>
      {active !== undefined && <StatusLine testId="provider-detail" status={active} />}
      {state.current === 'local' && (
        <UrlField testId="local-base-url" value={urlDraft} saved={state.localBaseUrl} busy={busy} onChange={onUrlDraft} onApply={() => apply({ localBaseUrl: urlDraft })} />
      )}

      <label className="mb-1.5 mt-4 block text-[11px] font-medium uppercase tracking-wider text-slate-500" htmlFor="code-provider-select">
        Writes the code
      </label>
      <select
        id="code-provider-select"
        data-testid="code-provider-select"
        value={state.codeProvider ?? 'same'}
        disabled={busy}
        onChange={(event) => apply({ codeProvider: event.target.value as ProviderName | 'same' })}
        title="Which model writes the application's code on Generate Application. The plan is still made by the model above."
        className={SELECT_CLASS}
      >
        <option value="same">Same as above</option>
        {options}
      </select>
      {code !== undefined && <StatusLine status={code} />}
      {state.codeProvider === 'local-code' && (
        <UrlField
          testId="local-code-base-url"
          value={codeUrlDraft}
          saved={state.localCodeBaseUrl}
          busy={busy}
          onChange={onCodeUrlDraft}
          onApply={() => apply({ localCodeBaseUrl: codeUrlDraft })}
        />
      )}

      {urlError !== null && (
        <p data-testid="provider-url-error" className="mt-3 rounded-lg bg-red-500/[0.1] px-2.5 py-2 text-[11px] text-red-300">
          {urlError}
        </p>
      )}
      <p className="mt-4 border-t border-white/[0.06] pt-3 text-[11px] leading-relaxed text-slate-500">
        Seven ways to run it free - Gemini, Groq, OpenRouter, GitHub Models, Ollama, and our own models on a free GPU. Setup steps: docs/FREE-SETUP.md.
      </p>
    </div>
  );
}

function StatusLine({ status, testId }: { readonly status: ProviderStatus; readonly testId?: string }): JSX.Element {
  return (
    <p data-testid={testId} className={`mt-1.5 flex gap-1.5 text-[11px] leading-snug ${status.available ? 'text-slate-400' : 'text-amber-300'}`}>
      <span className={`mt-[5px] h-1.5 w-1.5 flex-shrink-0 rounded-full ${status.available ? 'bg-emerald-400' : 'bg-amber-400'}`} />
      <span>{status.available ? `${status.model} - ${status.detail}` : status.detail}</span>
    </p>
  );
}

interface UrlFieldProps {
  readonly testId: string;
  readonly value: string;
  readonly saved: string;
  readonly busy: boolean;
  readonly onChange: (value: string) => void;
  readonly onApply: () => void;
}

/** Where a local or tunnelled inference server is: paste a new tunnel address here each GPU session. */
function UrlField({ testId, value, saved, busy, onChange, onApply }: UrlFieldProps): JSX.Element {
  return (
    <form
      className="mt-2 flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        onApply();
      }}
    >
      <input
        type="text"
        data-testid={testId}
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        placeholder="https://your-gpu-session-address"
        title="Where the inference server is reachable. Paste the new address each cloud GPU session."
        className="h-8 min-w-0 flex-1 rounded-[9px] border border-white/[0.09] bg-black/30 px-2.5 text-xs text-slate-100 placeholder:text-slate-500 disabled:opacity-60"
      />
      <button type="submit" data-testid={`${testId}-apply`} disabled={busy || value === saved} className="btn btn-primary btn-sm">
        {busy ? '…' : 'Connect'}
      </button>
    </form>
  );
}
