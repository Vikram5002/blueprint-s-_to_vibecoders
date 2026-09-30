/**
 * Editor side of the motion features (mirrors src/generate/canvas-motion.ts -
 * rule 4): the same CSS classes, so shimmer, marquee, gradient border and word
 * reveal animate on the canvas exactly as on the generated page, and the hover
 * effects for Preview mode.
 */
export const HOVER_EFFECTS = ['lift', 'glow', 'tilt', 'magnetic', 'spotlight'] as const;
export type HoverEffect = (typeof HOVER_EFFECTS)[number];

export const HOVER_LABEL: Readonly<Record<HoverEffect, string>> = {
  lift: 'Lift',
  glow: 'Glow',
  tilt: '3D tilt',
  magnetic: 'Magnetic',
  spotlight: 'Spotlight',
};

export const HOVER_CLASS: Readonly<Record<HoverEffect, string>> = {
  lift: 'vb-hover-lift',
  glow: 'vb-hover-glow',
  tilt: 'vb-hover-move',
  magnetic: 'vb-hover-move',
  spotlight: 'vb-spotlight',
};

/** Same rules the generated page carries (canvas-motion.ts CSS). */
export const MOTION_CSS = [
  '@keyframes vb-caret { 50% { opacity: 0; } }',
  '.vb-caret { margin-left: 2px; animation: vb-caret 1s step-end infinite; }',
  '@keyframes vb-shimmer { to { background-position: -200% center; } }',
  '.vb-shimmer { background-size: 200% auto; -webkit-background-clip: text; background-clip: text; color: transparent; animation: vb-shimmer 2.4s linear infinite; }',
  '@keyframes vb-word { from { opacity: 0; transform: translateY(12px); filter: blur(4px); } to { opacity: 1; transform: none; filter: none; } }',
  '.vb-word { display: inline-block; opacity: 0; animation: vb-word 600ms ease-out forwards; }',
  '@keyframes vb-marquee { to { transform: translateX(-50%); } }',
  '.vb-marquee { display: flex; gap: 48px; width: max-content; padding-right: 48px; animation: vb-marquee 22s linear infinite; }',
  '@keyframes vb-border { to { background-position: 0 0, 300% 0; } }',
  '.vb-gradient-border { animation: vb-border 5s linear infinite; }',
  '.vb-hover-lift { transition: transform 200ms ease, box-shadow 200ms ease; }',
  '.vb-hover-lift:hover { transform: translateY(-4px); box-shadow: 0 14px 30px rgba(0, 0, 0, 0.18); }',
  '.vb-hover-glow { transition: box-shadow 200ms ease, filter 200ms ease; }',
  '.vb-hover-glow:hover { box-shadow: 0 0 28px rgba(99, 102, 241, 0.55); filter: brightness(1.05); }',
  '.vb-hover-move { transition: transform 120ms ease-out; }',
  '.vb-spotlight { overflow: hidden; }',
  ".vb-spotlight::after { content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity 200ms; background: radial-gradient(220px circle at var(--vb-x, 50%) var(--vb-y, 50%), rgba(255, 255, 255, 0.28), transparent 60%); }",
  '.vb-spotlight:hover::after { opacity: 1; }',
].join('\n');

/** Preview-mode pointer handling for the effects that follow the pointer. */
export function hoverHandlers(effect: HoverEffect | undefined): {
  readonly onMouseMove?: (event: React.MouseEvent<HTMLElement>) => void;
  readonly onMouseLeave?: (event: React.MouseEvent<HTMLElement>) => void;
} {
  const position = (
    event: React.MouseEvent<HTMLElement>,
  ): { el: HTMLElement; x: number; y: number; px: number; py: number } => {
    const el = event.currentTarget;
    const r = el.getBoundingClientRect();
    return {
      el,
      x: (event.clientX - r.left) / r.width - 0.5,
      y: (event.clientY - r.top) / r.height - 0.5,
      px: event.clientX - r.left,
      py: event.clientY - r.top,
    };
  };
  const reset = (event: React.MouseEvent<HTMLElement>): void => {
    event.currentTarget.style.transform = '';
  };
  if (effect === 'tilt') {
    return {
      onMouseMove: (event) => {
        const { el, x, y } = position(event);
        el.style.transform = `perspective(700px) rotateX(${(-y * 10).toFixed(2)}deg) rotateY(${(x * 10).toFixed(2)}deg)`;
      },
      onMouseLeave: reset,
    };
  }
  if (effect === 'magnetic') {
    return {
      onMouseMove: (event) => {
        const { el, x, y } = position(event);
        el.style.transform = `translate(${(x * 14).toFixed(1)}px, ${(y * 14).toFixed(1)}px)`;
      },
      onMouseLeave: reset,
    };
  }
  if (effect === 'spotlight') {
    return {
      onMouseMove: (event) => {
        const { el, px, py } = position(event);
        el.style.setProperty('--vb-x', `${px}px`);
        el.style.setProperty('--vb-y', `${py}px`);
      },
    };
  }
  return {};
}
