/**
 * Motion-Primitives-style effects for Page Builder pages, with no animation
 * library in the generated site: CSS keyframes plus a few small React helpers,
 * each emitted only when the page uses it.
 *
 *   - Animated elements: typewriter, text shimmer, text scramble, word reveal,
 *     animated counter, marquee (infinite slider), gradient-border card.
 *   - Effects any element can take: a hover effect (lift, glow, tilt,
 *     magnetic, spotlight) and reveal-on-scroll.
 *
 * Deterministic output: the same layout always produces the same source.
 * (The scramble picks random glyphs at runtime in the browser - that is the
 * visual effect itself, not generation.)
 */
import type { ElementContext } from './canvas-elements.js';

export const MOTION_ELEMENT_TYPES = ['typewriter', 'text-shimmer', 'text-scramble', 'word-reveal', 'counter', 'marquee', 'gradient-border'] as const;
export type MotionElementType = (typeof MOTION_ELEMENT_TYPES)[number];

export const HOVER_EFFECTS = ['lift', 'glow', 'tilt', 'magnetic', 'spotlight'] as const;
export type HoverEffect = (typeof HOVER_EFFECTS)[number];

/** What the page needs from the motion runtime, gathered while rendering. */
export interface MotionUse {
  readonly types: ReadonlySet<string>;
  readonly hovers: ReadonlySet<HoverEffect>;
  readonly reveal: boolean;
}

function parts(label: string): string[] {
  return label.split('|').map((part) => part.trim()).filter((part) => part !== '');
}

function textSize(c: ElementContext): number {
  return Math.max(14, Math.min(64, Math.round(c.height * 0.55)));
}

function head(tag: string, c: ElementContext, style: string, extra = ''): string {
  return `<${tag}${extra} data-testid="${c.id}" style={{ ${c.position}, boxSizing: 'border-box', ${style} }}>`;
}

// ---- elements -------------------------------------------------------------------

function typewriter(c: ElementContext): string {
  return `${head('span', c, `display: 'flex', alignItems: 'center', color: '${c.color}', fontSize: ${textSize(c)}, fontWeight: 700`)}<VbTypewriter text={${JSON.stringify(c.label)}} /></span>`;
}

function textShimmer(c: ElementContext): string {
  return `${head('span', c, `display: 'flex', alignItems: 'center', fontSize: ${textSize(c)}, fontWeight: 700`)}<span className="vb-shimmer" style={{ backgroundImage: 'linear-gradient(90deg, ${c.color} 0%, ${c.color} 35%, #ffffff 50%, ${c.color} 65%, ${c.color} 100%)' }}>${c.text(c.label)}</span></span>`;
}

function textScramble(c: ElementContext): string {
  return `${head('span', c, `display: 'flex', alignItems: 'center', color: '${c.color}', fontSize: ${textSize(c)}, fontWeight: 700, fontFamily: 'ui-monospace, monospace'`)}<VbScramble text={${JSON.stringify(c.label)}} /></span>`;
}

function wordReveal(c: ElementContext): string {
  const words = c.label.split(/\s+/).filter(Boolean);
  const spans = words.map((word, i) => `<span className="vb-word" style={{ animationDelay: '${i * 90}ms' }}>${c.text(word)}</span>`).join(' ');
  return `${head('span', c, `display: 'flex', flexWrap: 'wrap', alignContent: 'center', gap: '0 0.3em', color: '${c.color}', fontSize: ${textSize(c)}, fontWeight: 700`)}${spans}</span>`;
}

function counter(c: ElementContext): string {
  const [value = '1000', suffix = '', caption = ''] = parts(c.label);
  const to = Math.max(0, Math.round(Number(value.replace(/[^0-9.]/g, '')) || 0));
  const size = Math.max(20, Math.min(64, Math.round(c.height * 0.45)));
  return `${head('div', c, `display: 'flex', flexDirection: 'column', justifyContent: 'center'`)}<strong style={{ fontSize: ${size}, color: '${c.color}', lineHeight: 1.1 }}><VbCounter to={${to}} />${c.text(suffix)}</strong><span style={{ fontSize: 14, color: '${c.muted}' }}>${c.text(caption)}</span></div>`;
}

function marquee(c: ElementContext): string {
  const items = parts(c.label).map((item) => `<span style={{ fontSize: 20, fontWeight: 600, color: '${c.color}', whiteSpace: 'nowrap' }}>${c.text(item)}</span>`).join('');
  return `${head('div', c, `overflow: 'hidden', display: 'flex', alignItems: 'center', maskImage: 'linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent)'`)}<div className="vb-marquee">${items}${items}</div></div>`;
}

function gradientBorder(c: ElementContext): string {
  const [title = 'Featured', body = ''] = parts(c.label);
  const style = `border: '2px solid transparent', borderRadius: 16, padding: 20, display: 'flex', flexDirection: 'column', gap: 8, background: 'linear-gradient(${c.surface}, ${c.surface}) padding-box, linear-gradient(120deg, ${c.color}, #ffffff, ${c.color}, #ffffff, ${c.color}) border-box', backgroundSize: '100% 100%, 300% 300%'`;
  return `${head('div', c, style, ' className="vb-gradient-border"')}<h3 style={{ margin: 0, fontSize: 20, color: '${c.ink}' }}>${c.text(title)}</h3><p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: '${c.muted}' }}>${c.text(body)}</p></div>`;
}

export const MOTION_RENDERERS: Readonly<Record<MotionElementType, (c: ElementContext) => string>> = {
  typewriter,
  'text-shimmer': textShimmer,
  'text-scramble': textScramble,
  'word-reveal': wordReveal,
  counter,
  marquee,
  'gradient-border': gradientBorder,
};

// ---- effects on any element ----------------------------------------------------

const HOVER_CLASS: Readonly<Record<HoverEffect, string>> = { lift: 'vb-hover-lift', glow: 'vb-hover-glow', tilt: 'vb-hover-move', magnetic: 'vb-hover-move', spotlight: 'vb-spotlight' };
const HOVER_HANDLERS: Readonly<Partial<Record<HoverEffect, string>>> = {
  tilt: 'onMouseMove={vbTilt} onMouseLeave={vbReset}',
  magnetic: 'onMouseMove={vbMagnet} onMouseLeave={vbReset}',
  spotlight: 'onMouseMove={vbSpot}',
};

/** Adds an element's hover effect and scroll reveal to its root tag, merging any className it already has. */
export function applyEffects(markup: string, hover: HoverEffect | undefined, reveal: boolean): string {
  const classes = [...(hover === undefined ? [] : [HOVER_CLASS[hover]]), ...(reveal ? ['vb-reveal'] : [])];
  const handlers = hover === undefined ? undefined : HOVER_HANDLERS[hover];
  if (classes.length === 0 && handlers === undefined) return markup;
  const tagEnd = markup.search(/[\s>]/);
  const rootTag = markup.slice(0, markup.indexOf('>') + 1);
  const existing = /^[^>]*?\sclassName="([^"]*)"/.exec(rootTag);
  let result = markup;
  if (classes.length > 0) {
    result = existing !== null
      ? result.replace(`className="${existing[1] ?? ''}"`, `className="${[existing[1], ...classes].join(' ')}"`)
      : `${result.slice(0, tagEnd)} className="${classes.join(' ')}"${result.slice(tagEnd)}`;
  }
  if (handlers !== undefined) {
    const at = result.search(/[\s>]/);
    result = `${result.slice(0, at)} ${handlers}${result.slice(at)}`;
  }
  return result;
}

// ---- runtime: helpers, hooks, css ---------------------------------------------------

const HELPERS: Readonly<Record<string, readonly string[]>> = {
  typewriter: [
    'function VbTypewriter({ text }: { readonly text: string }) {',
    '  const [shown, setShown] = useState(0);',
    '  useEffect(() => {',
    '    if (shown >= text.length) return undefined;',
    '    const timer = setTimeout(() => setShown(shown + 1), 55);',
    '    return () => clearTimeout(timer);',
    '  }, [shown, text]);',
    '  return (',
    '    <>',
    '      {text.slice(0, shown)}',
    '      <span className="vb-caret">|</span>',
    '    </>',
    '  );',
    '}',
  ],
  'text-scramble': [
    "const VB_GLYPHS = '!<>-_[]{}=+*^?#%&';",
    'function VbScramble({ text }: { readonly text: string }) {',
    '  const [out, setOut] = useState(text);',
    '  useEffect(() => {',
    '    let frame = 0;',
    '    const id = setInterval(() => {',
    '      frame += 1;',
    "      setOut(text.split('').map((ch, i) => (i < frame / 2 || ch === ' ' ? ch : VB_GLYPHS[Math.floor(Math.random() * VB_GLYPHS.length)])).join(''));",
    '      if (frame / 2 > text.length) clearInterval(id);',
    '    }, 40);',
    '    return () => clearInterval(id);',
    '  }, [text]);',
    '  return <>{out}</>;',
    '}',
  ],
  counter: [
    'function VbCounter({ to }: { readonly to: number }) {',
    '  const [value, setValue] = useState(0);',
    '  useEffect(() => {',
    '    const start = performance.now();',
    '    let frame = 0;',
    '    const tick = (now: number) => {',
    '      const progress = Math.min(1, (now - start) / 1600);',
    '      setValue(Math.round(to * (1 - Math.pow(1 - progress, 3))));',
    '      if (progress < 1) frame = requestAnimationFrame(tick);',
    '    };',
    '    frame = requestAnimationFrame(tick);',
    '    return () => cancelAnimationFrame(frame);',
    '  }, [to]);',
    '  return <>{value.toLocaleString()}</>;',
    '}',
  ],
  tilt: [
    'function vbTilt(event: MouseEvent<HTMLElement>) {',
    '  const el = event.currentTarget;',
    '  const r = el.getBoundingClientRect();',
    '  const x = (event.clientX - r.left) / r.width - 0.5;',
    '  const y = (event.clientY - r.top) / r.height - 0.5;',
    '  el.style.transform = `perspective(700px) rotateX(${(-y * 10).toFixed(2)}deg) rotateY(${(x * 10).toFixed(2)}deg)`;',
    '}',
  ],
  magnetic: [
    'function vbMagnet(event: MouseEvent<HTMLElement>) {',
    '  const el = event.currentTarget;',
    '  const r = el.getBoundingClientRect();',
    '  const x = (event.clientX - r.left) / r.width - 0.5;',
    '  const y = (event.clientY - r.top) / r.height - 0.5;',
    '  el.style.transform = `translate(${(x * 14).toFixed(1)}px, ${(y * 14).toFixed(1)}px)`;',
    '}',
  ],
  reset: ['function vbReset(event: MouseEvent<HTMLElement>) {', "  event.currentTarget.style.transform = '';", '}'],
  spotlight: [
    'function vbSpot(event: MouseEvent<HTMLElement>) {',
    '  const el = event.currentTarget;',
    '  const r = el.getBoundingClientRect();',
    "  el.style.setProperty('--vb-x', `${event.clientX - r.left}px`);",
    "  el.style.setProperty('--vb-y', `${event.clientY - r.top}px`);",
    '}',
  ],
};

const REVEAL_HOOK = [
  '  useEffect(() => {',
  '    const observer = new IntersectionObserver(',
  '      (entries) =>',
  '        entries.forEach((entry) => {',
  '          if (!entry.isIntersecting) return;',
  "          entry.target.classList.add('vb-in');",
  '          observer.unobserve(entry.target);',
  '        }),',
  '      { threshold: 0.15 },',
  '    );',
  "    document.querySelectorAll('.vb-reveal').forEach((el) => observer.observe(el));",
  '    return () => observer.disconnect();',
  '  }, []);',
  '',
].join('\n');

const CSS: Readonly<Record<string, readonly string[]>> = {
  typewriter: ['@keyframes vb-caret { 50% { opacity: 0; } }', '.vb-caret { margin-left: 2px; animation: vb-caret 1s step-end infinite; }'],
  'text-shimmer': [
    '@keyframes vb-shimmer { to { background-position: -200% center; } }',
    '.vb-shimmer { background-size: 200% auto; -webkit-background-clip: text; background-clip: text; color: transparent; animation: vb-shimmer 2.4s linear infinite; }',
  ],
  'word-reveal': [
    '@keyframes vb-word { from { opacity: 0; transform: translateY(12px); filter: blur(4px); } to { opacity: 1; transform: none; filter: none; } }',
    '.vb-word { display: inline-block; opacity: 0; animation: vb-word 600ms ease-out forwards; }',
  ],
  marquee: [
    '@keyframes vb-marquee { to { transform: translateX(-50%); } }',
    '.vb-marquee { display: flex; gap: 48px; width: max-content; padding-right: 48px; animation: vb-marquee 22s linear infinite; }',
  ],
  'gradient-border': ['@keyframes vb-border { to { background-position: 0 0, 300% 0; } }', '.vb-gradient-border { animation: vb-border 5s linear infinite; }'],
  lift: ['.vb-hover-lift { transition: transform 200ms ease, box-shadow 200ms ease; }', '.vb-hover-lift:hover { transform: translateY(-4px); box-shadow: 0 14px 30px rgba(0, 0, 0, 0.18); }'],
  glow: ['.vb-hover-glow { transition: box-shadow 200ms ease, filter 200ms ease; }', '.vb-hover-glow:hover { box-shadow: 0 0 28px rgba(99, 102, 241, 0.55); filter: brightness(1.05); }'],
  tilt: ['.vb-hover-move { transition: transform 120ms ease-out; }'],
  magnetic: ['.vb-hover-move { transition: transform 120ms ease-out; }'],
  spotlight: [
    '.vb-spotlight { overflow: hidden; }',
    ".vb-spotlight::after { content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity 200ms; background: radial-gradient(220px circle at var(--vb-x, 50%) var(--vb-y, 50%), rgba(255, 255, 255, 0.28), transparent 60%); }",
    '.vb-spotlight:hover::after { opacity: 1; }',
  ],
  reveal: ['.vb-reveal { opacity: 0; transform: translateY(28px); transition: opacity 700ms ease, transform 700ms ease; }', '.vb-reveal.vb-in { opacity: 1; transform: none; }'],
};

export interface MotionRuntime {
  /** React value imports the runtime needs. */
  readonly values: readonly string[];
  /** React type imports the runtime needs. */
  readonly types: readonly string[];
  /** Module-level helper code, placed after the imports; empty when unused. */
  readonly helpers: string;
  /** Code at the top of the page component; empty when unused. */
  readonly hooks: string;
  /** CSS rules for the page's style block; empty when unused. */
  readonly css: readonly string[];
}

export function motionRuntime(use: MotionUse): MotionRuntime {
  const keys = [
    ...MOTION_ELEMENT_TYPES.filter((type) => use.types.has(type)),
    ...HOVER_EFFECTS.filter((effect) => use.hovers.has(effect)),
  ];
  const cssKeys = keys.filter((key, i) => !(key === 'magnetic' && keys.includes('tilt')) || i < 0);
  const handlerHovers = (['tilt', 'magnetic', 'spotlight'] as const).filter((h) => use.hovers.has(h));
  const helperKeys = [...keys.filter((key) => key in HELPERS), ...(use.hovers.has('tilt') || use.hovers.has('magnetic') ? ['reset'] : [])];
  const helpers = helperKeys.map((key) => (HELPERS[key] ?? []).join('\n')).join('\n\n');
  const needsState = ['typewriter', 'text-scramble', 'counter'].some((type) => use.types.has(type));
  const values = [...(needsState || use.reveal ? ['useEffect'] : []), ...(needsState ? ['useState'] : [])];
  return {
    values,
    types: handlerHovers.length > 0 ? ['MouseEvent'] : [],
    helpers,
    hooks: use.reveal ? REVEAL_HOOK : '',
    css: [...cssKeys.flatMap((key) => CSS[key] ?? []), ...(use.reveal ? CSS['reveal'] ?? [] : [])],
  };
}
