import { useState } from 'react';
import { OWN_KEY_PROVIDERS, ownKey, setOwnKey, type OwnKeyProvider } from '../hosted-client';

/**
 * "Use my own API key": the person's key, kept in this browser only and sent
 * with their own requests (hosted-client.ts). On a hosted server this is how
 * a visitor goes past the shared model's daily limit; on a local install it
 * saves editing .env.
 */
export function OwnKeySection({ hosted }: { readonly hosted: boolean }): JSX.Element {
  const saved = ownKey();
  const [provider, setProvider] = useState<OwnKeyProvider>(saved?.provider ?? 'groq');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(saved?.model ?? '');
  const [editing, setEditing] = useState(saved === null);
  const meta = OWN_KEY_PROVIDERS.find((entry) => entry.id === provider) ?? OWN_KEY_PROVIDERS[0];

  if (saved !== null && !editing) {
    const label =
      OWN_KEY_PROVIDERS.find((entry) => entry.id === saved.provider)?.label ?? saved.provider;
    return (
      <section data-testid="own-key" className="mt-4 border-t border-white/[0.06] pt-3">
        <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
          Your own API key
        </p>
        <p data-testid="own-key-active" className="mt-1.5 text-[12px] text-emerald-300">
          Using your {label} key{saved.model !== undefined ? ` (${saved.model})` : ''} for
          everything you run here.
        </p>
        <div className="mt-2 flex gap-1.5">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setEditing(true)}
          >
            Change
          </button>
          <button
            type="button"
            data-testid="own-key-remove"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setOwnKey(null);
              setEditing(true);
            }}
          >
            Stop using it
          </button>
        </div>
      </section>
    );
  }

  return (
    <form
      data-testid="own-key"
      className="mt-4 border-t border-white/[0.06] pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        setOwnKey({
          provider,
          apiKey: apiKey.trim(),
          ...(model.trim() === '' ? {} : { model: model.trim() }),
        });
        setApiKey('');
        setEditing(false);
      }}
    >
      <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
        Use your own API key
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
        {hosted
          ? "Runs on this server's model are limited per day. With your own free key there is no limit here."
          : 'Instead of editing .env: paste a key and it is used for what you run in this browser.'}{' '}
        The key stays in this browser and is never saved on the server.
      </p>
      <label htmlFor="own-key-provider" className="sr-only">
        Provider
      </label>
      <select
        id="own-key-provider"
        data-testid="own-key-provider"
        value={provider}
        onChange={(event) => setProvider(event.target.value as OwnKeyProvider)}
        className="mt-2 h-8 w-full rounded-[9px] border border-white/[0.09] bg-white/[0.05] pl-2.5 text-xs text-slate-100"
      >
        {OWN_KEY_PROVIDERS.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </select>
      <label htmlFor="own-key-value" className="sr-only">
        API key
      </label>
      <input
        id="own-key-value"
        data-testid="own-key-value"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="Paste your API key"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        className="mt-1.5 h-8 w-full rounded-[9px] border border-white/[0.09] bg-black/30 px-2.5 text-xs text-slate-100 placeholder:text-slate-500"
      />
      <label htmlFor="own-key-model" className="sr-only">
        Model (optional)
      </label>
      <input
        id="own-key-model"
        data-testid="own-key-model"
        type="text"
        placeholder="Model (optional - the usual one if empty)"
        value={model}
        onChange={(event) => setModel(event.target.value)}
        className="mt-1.5 h-8 w-full rounded-[9px] border border-white/[0.09] bg-black/30 px-2.5 text-xs text-slate-100 placeholder:text-slate-500"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="submit"
          data-testid="own-key-save"
          disabled={apiKey.trim().length < 8}
          className="btn btn-primary btn-sm"
        >
          Use this key
        </button>
        {saved !== null && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
        )}
        <a
          href={meta.keyUrl}
          target="_blank"
          rel="noreferrer"
          className="ml-auto text-[11px] text-sky-300 hover:underline"
        >
          Get a key
        </a>
      </div>
    </form>
  );
}
