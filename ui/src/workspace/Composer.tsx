import { useEffect, useRef } from 'react';
import { Icon } from '../design/Icon';

interface ComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly running: boolean;
  readonly onStop: () => void;
  readonly reviewFirst: boolean;
  readonly onReviewFirst: (value: boolean) => void;
  /** `hero` sits in the middle of an empty page with room to write; `dock` stays at the bottom once a run exists. */
  readonly variant: 'hero' | 'dock';
  /** Changes whenever the composer should take focus again ("New project"). */
  readonly focusKey?: number;
}

const MAX_HEIGHT = 240;

/**
 * Where a request is written: one rounded frame that lights up while typing,
 * the text growing with what is written, and the send button inside it. Enter
 * builds; Shift+Enter starts a new line.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  running,
  onStop,
  reviewFirst,
  onReviewFirst,
  variant,
  focusKey,
}: ComposerProps): JSX.Element {
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  // Grow with the text, up to a limit, instead of scrolling inside two lines.
  useEffect(() => {
    const text = textRef.current;
    if (text === null) return;
    text.style.height = 'auto';
    text.style.height = `${Math.min(text.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  useEffect(() => {
    if (focusKey !== undefined) textRef.current?.focus();
  }, [focusKey]);

  const empty = value.trim() === '';

  return (
    <div
      className={`focus-glow card !rounded-[22px] !bg-[#141417]/90 p-2 text-left backdrop-blur-xl ${variant === 'hero' ? 'shadow-[0_30px_80px_-40px_rgba(109,106,248,0.55)]' : ''}`}
    >
      <textarea
        ref={textRef}
        data-testid="agent-prompt"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
        rows={variant === 'hero' ? 3 : 1}
        autoFocus={variant === 'hero'}
        aria-label="Describe the application you want"
        placeholder={
          variant === 'hero'
            ? 'Describe the app you want - who uses it and what they can do. For example: a booking site for a yoga studio, with class schedules, sign-up and an admin page.'
            : 'Describe another app, or a change to try…'
        }
        className="block max-h-[240px] w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-[15px] leading-relaxed text-slate-50 placeholder:text-slate-500 focus-visible:outline-none"
      />
      <div className="flex items-center gap-3 px-1.5 pb-0.5 pt-1.5">
        <label className="flex cursor-pointer select-none items-center gap-2 rounded-full py-1 pl-1 pr-2 text-xs text-slate-400 hover:text-slate-200">
          <span className="switch">
            <input
              type="checkbox"
              data-testid="agent-review-first"
              checked={reviewFirst}
              disabled={running}
              onChange={(event) => onReviewFirst(event.target.checked)}
            />
            <span className="switch-track" />
            <span className="switch-thumb" />
          </span>
          Review the plan first
        </label>
        <span className="ml-auto hidden text-[11px] text-slate-500 md:inline">
          <span className="kbd">Enter</span> to build · <span className="kbd">Shift</span> +{' '}
          <span className="kbd">Enter</span> new line
        </span>
        {running ? (
          <button
            type="button"
            data-testid="agent-stop"
            onClick={onStop}
            aria-label="Stop"
            title="Stop - anything already generated is kept"
            className="btn btn-danger btn-icon ml-auto md:ml-0"
          >
            <Icon name="stop" size={14} />
          </button>
        ) : (
          <button
            type="button"
            data-testid="agent-start"
            onClick={onSubmit}
            disabled={empty}
            aria-label="Build it"
            title="Build it (Enter)"
            className="btn btn-primary btn-icon ml-auto md:ml-0"
          >
            <Icon name="arrow-up" size={16} strokeWidth={2.2} />
          </button>
        )}
      </div>
    </div>
  );
}
