import { useEffect, useRef, useState } from 'react';
import { Icon } from '../design/Icon';
import { LogoMark } from '../design/Logo';
import { applyDesignOperations, designViaApi, type ChatTurn } from './page-designer';
import { useWorkspaceStore } from './store';

interface Message extends ChatTurn {
  /** For designer turns: how many edits landed on the canvas, and how many the checks refused. */
  readonly changed?: number;
  readonly refused?: number;
  readonly failed?: boolean;
}

const SUGGESTIONS = [
  'Add a hero with a headline, a short tagline and a sign-up button',
  'Add a pricing section with three plans below',
  'Line everything up and space it evenly',
  'Make all the buttons green',
];

/**
 * The Page Builder's designer agent: a small chat that edits the canvas.
 *
 * It never blocks the canvas - a person can keep dragging and editing while a
 * request is out, and the reply is applied to the canvas as it is when it
 * arrives (page-designer.ts), as one undo step, so Ctrl+Z takes back exactly
 * what the designer did.
 */
export function DesignerChat(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const setElements = useWorkspaceStore((state) => state.setElements);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function send(text: string): Promise<void> {
    const instruction = text.trim();
    if (instruction === '' || busy) return;
    setDraft('');
    const history = messages.filter((message) => message.failed !== true).map(({ role, text: said }) => ({ role, text: said }));
    setMessages((current) => [...current, { role: 'user', text: instruction }]);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    // The page as it is now goes with the request; the reply is applied to the page as it is THEN.
    const { pageName, elements, theme } = useWorkspaceStore.getState().pageBuilder;
    try {
      const reply = await designViaApi(instruction, { id: 'designer', pageName, elements, ...(theme === undefined ? {} : { theme }) }, history, controller.signal);
      let changed = 0;
      if (reply.operations.length > 0) {
        setElements((current) => {
          const applied = applyDesignOperations(current, reply.operations);
          changed = applied.changed;
          return applied.elements;
        });
      }
      setMessages((current) => [...current, { role: 'designer', text: reply.reply, changed, refused: reply.refused }]);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setMessages((current) => [...current, { role: 'designer', text: cause instanceof Error ? cause.message : String(cause), failed: true }]);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="designer-open"
        onClick={() => setOpen(true)}
        title="Designer agent - describe a change and it edits the page"
        className="btn btn-primary anim-pop fixed bottom-6 right-6 z-40 !h-11 !rounded-full !px-5 shadow-[0_18px_40px_-14px_rgba(109,106,248,0.8)]"
      >
        <Icon name="sparkles" size={16} />
        Designer
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Designer agent"
      data-testid="designer-chat"
      className="anim-pop fixed bottom-6 right-6 z-40 flex h-[min(520px,calc(100vh-120px))] w-[min(380px,calc(100vw-48px))] flex-col overflow-hidden rounded-2xl border border-white/[0.1] bg-[#141417]/[0.97] shadow-[var(--shadow-pop)] backdrop-blur-2xl"
    >
      <div className="flex items-center gap-2.5 border-b border-white/[0.07] px-4 py-3">
        <LogoMark size={22} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-slate-50">Designer agent</div>
          <div className="text-[11px] text-slate-500">Edits this page with you - keep working while it thinks</div>
        </div>
        <button type="button" data-testid="designer-close" onClick={() => setOpen(false)} aria-label="Close the designer" className="btn btn-ghost btn-sm !h-7 !w-7 !p-0">
          <Icon name="x" size={14} />
        </button>
      </div>

      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-xs leading-relaxed text-slate-400">Describe what you want on the page. Every change is one undo step (Ctrl+Z).</p>
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                data-testid="designer-suggestion"
                onClick={() => void send(suggestion)}
                className="card card-hover block w-full !rounded-xl px-3 py-2 text-left text-xs text-slate-300"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
        {messages.map((message, index) =>
          message.role === 'user' ? (
            <div key={index} className="anim-view ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-gradient-to-br from-[#7b72ff] to-[#1e7cf5] px-3 py-2 text-[13px] text-white">
              {message.text}
            </div>
          ) : (
            <div key={index} data-testid="designer-reply" className="anim-view max-w-[90%] space-y-1.5">
              <div className={`rounded-2xl rounded-bl-md px-3 py-2 text-[13px] ${message.failed === true ? 'bg-red-500/[0.1] text-red-200' : 'bg-white/[0.06] text-slate-200'}`}>{message.text}</div>
              {message.failed !== true && (
                <div className="flex items-center gap-1.5 pl-1 text-[11px] text-slate-500">
                  {message.changed !== undefined && message.changed > 0 ? (
                    <>
                      <Icon name="check" size={11} strokeWidth={2.4} className="text-emerald-400" />
                      {message.changed} change{message.changed === 1 ? '' : 's'} on the page · Ctrl+Z undoes them
                    </>
                  ) : (
                    'No change to the page'
                  )}
                  {(message.refused ?? 0) > 0 && <span className="text-amber-400/80">· {message.refused} refused by the checks</span>}
                </div>
              )}
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="spinner !h-3.5 !w-3.5" />
            Designing…
          </div>
        )}
      </div>

      <form
        className="border-t border-white/[0.07] p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <div className="focus-glow flex items-end gap-2 rounded-xl border border-white/[0.08] bg-black/25 p-1.5 pl-3">
          <textarea
            data-testid="designer-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
            rows={2}
            placeholder="e.g. add a contact form on the right"
            aria-label="Tell the designer what to change"
            className="min-w-0 flex-1 resize-none bg-transparent py-1 text-[13px] text-slate-100 placeholder:text-slate-500 focus-visible:outline-none"
          />
          <button type="submit" data-testid="designer-send" disabled={busy || draft.trim() === ''} aria-label="Send to the designer" className="btn btn-primary btn-icon !h-8 !w-8">
            <Icon name="arrow-up" size={15} strokeWidth={2.2} />
          </button>
        </div>
      </form>
    </div>
  );
}
