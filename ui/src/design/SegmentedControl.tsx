import { useLayoutEffect, useRef, useState } from 'react';

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly title?: string;
  readonly disabled?: boolean;
  /** Stable hook for tests; defaults to none. */
  readonly testId?: string;
}

interface SegmentedControlProps<T extends string> {
  readonly options: readonly SegmentOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly ariaLabel: string;
  /**
   * `tabs` renders role="tablist"/"tab" with aria-selected - for switching
   * between views. `choice` renders role="radiogroup"/"radio" with
   * aria-checked - for picking a mode within one view. `toggles` keeps each
   * segment a plain button with aria-pressed, for places where callers (and
   * tests) already address them as buttons.
   */
  readonly kind?: 'tabs' | 'choice' | 'toggles';
  readonly size?: 'regular' | 'small';
  readonly className?: string;
}

/**
 * The iOS segmented control: a pill track with one raised thumb that glides
 * to the chosen segment rather than the highlight jumping. The thumb's
 * position and width are measured from the real buttons, so segments of any
 * width work, and they are re-measured whenever the control resizes (fonts
 * loading, the window narrowing).
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  kind = 'choice',
  size = 'regular',
  className,
}: SegmentedControlProps<T>): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<T, HTMLButtonElement>());
  const [thumb, setThumb] = useState<{ readonly left: number; readonly width: number } | null>(
    null,
  );
  // The first placement must not animate in from the left edge.
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (track === null) return;
    const measure = (): void => {
      const active = itemRefs.current.get(value);
      if (active === undefined) {
        setThumb(null);
        return;
      }
      setThumb({ left: active.offsetLeft, width: active.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [value, options]);

  useLayoutEffect(() => {
    if (thumb === null || ready) return;
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, [thumb, ready]);

  const itemRole = kind === 'tabs' ? 'tab' : kind === 'choice' ? 'radio' : undefined;
  const selectedAttribute = (selected: boolean): Record<string, boolean> =>
    kind === 'tabs'
      ? { 'aria-selected': selected }
      : kind === 'choice'
        ? { 'aria-checked': selected }
        : { 'aria-pressed': selected };

  function focusSibling(from: T, step: number): void {
    const enabled = options.filter((option) => option.disabled !== true);
    const index = enabled.findIndex((option) => option.value === from);
    const next = enabled[(index + step + enabled.length) % enabled.length];
    if (next === undefined) return;
    onChange(next.value);
    itemRefs.current.get(next.value)?.focus();
  }

  return (
    <div
      ref={trackRef}
      role={kind === 'tabs' ? 'tablist' : kind === 'choice' ? 'radiogroup' : 'group'}
      aria-label={ariaLabel}
      className={`seg${className === undefined ? '' : ` ${className}`}`}
      data-size={size}
    >
      <span
        aria-hidden="true"
        className="seg-thumb"
        style={{
          width: thumb?.width ?? 0,
          transform: `translateX(${thumb?.left ?? 0}px)`,
          opacity: thumb === null ? 0 : 1,
          transition: ready ? undefined : 'none',
        }}
      />
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              if (element === null) itemRefs.current.delete(option.value);
              else itemRefs.current.set(option.value, element);
            }}
            type="button"
            role={itemRole}
            className="seg-item"
            data-active={selected}
            data-testid={option.testId}
            title={option.title}
            disabled={option.disabled}
            tabIndex={kind === 'toggles' || selected ? 0 : -1}
            {...selectedAttribute(selected)}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                focusSibling(option.value, 1);
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                focusSibling(option.value, -1);
              }
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
