import { useEffect, useState, type ReactNode } from 'react';
import { NEEDS_ACCESS_CODE, accessCode, fetchHostedInfo, setAccessCode } from './hosted-client';
import { LogoMark } from './design/Logo';

type Gate =
  | { readonly kind: 'checking' }
  | { readonly kind: 'open' }
  | { readonly kind: 'locked'; readonly wrong: boolean };

/**
 * On a hosted server, nothing but this form until the access code is right.
 * The app renders straight away while that is being checked - a local server
 * (no /api/hosted) must not wait on a question that does not apply to it.
 */
export function HostedGate({ children }: { readonly children: ReactNode }): JSX.Element {
  const [gate, setGate] = useState<Gate>({ kind: 'checking' });
  const [draft, setDraft] = useState('');

  async function check(afterTyping: boolean): Promise<void> {
    const info = await fetchHostedInfo();
    if (info === null || info.accessOk) setGate({ kind: 'open' });
    else setGate({ kind: 'locked', wrong: afterTyping });
  }

  useEffect(() => {
    void check(false);
    const relock = (): void => setGate({ kind: 'locked', wrong: accessCode() !== null });
    window.addEventListener(NEEDS_ACCESS_CODE, relock);
    return () => window.removeEventListener(NEEDS_ACCESS_CODE, relock);
  }, []);

  if (gate.kind !== 'locked') return <>{children}</>;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0c0c0e] px-4 text-slate-100">
      <form
        data-testid="access-form"
        className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-[#151517] p-6"
        onSubmit={(event) => {
          event.preventDefault();
          setAccessCode(draft.trim());
          void check(true);
        }}
      >
        <LogoMark size={40} />
        <h1 className="mt-4 text-lg font-semibold tracking-tight">This VibeCoder is invite-only</h1>
        <p className="mt-1 text-sm text-slate-400">Enter the access code you were given.</p>
        <label htmlFor="access-code" className="mt-5 block text-xs font-medium text-slate-400">
          Access code
        </label>
        <input
          id="access-code"
          data-testid="access-code"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="mt-1.5 h-10 w-full rounded-[10px] border border-white/[0.1] bg-black/30 px-3 text-sm text-slate-100"
        />
        {gate.wrong && (
          <p role="alert" className="mt-2 text-xs text-red-300">
            That code is not right. Check it with the person who invited you.
          </p>
        )}
        <button
          type="submit"
          disabled={draft.trim() === ''}
          className="btn btn-primary mt-4 w-full"
        >
          Enter
        </button>
        <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
          The code is kept in this browser only. Want VibeCoder without a code? Run it on your own
          computer:
          <code className="ml-1 rounded bg-white/[0.06] px-1 text-slate-300">
            npx vibe-blueprint
          </code>
        </p>
      </form>
    </main>
  );
}
