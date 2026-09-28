/**
 * Page Builder widgets: layout helpers, navigation, overlays and page-level
 * utilities - the pieces a website builder offers beyond static blocks.
 *
 * Same rules as every other element: one deterministic template per type,
 * built from the element's position, colour and label ("|"-separated parts),
 * no library in the generated site. Interactive widgets use native HTML where
 * it does the job (a <details> dropdown needs no script) and a tiny React
 * helper otherwise, emitted only when the page uses that widget.
 *
 * Page-level widgets (back to top, scroll progress, floating button, cookie
 * banner, toast) are fixed to the browser window, not the canvas: their x/y
 * only decides where they sit in the editor.
 */
import type { ElementContext } from './canvas-elements.js';

export const WIDGET_TYPES = [
  'columns', 'spacer', 'sidebar', 'mobile-menu', 'modal', 'tooltip', 'dropdown-menu',
  'toast', 'back-to-top', 'scroll-progress', 'fab', 'cookie-banner',
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

function parts(label: string): string[] {
  return label.split('|').map((part) => part.trim()).filter((part) => part !== '');
}

function head(tag: string, c: ElementContext, style: string, extra = ''): string {
  return `<${tag}${extra} data-testid="${c.id}" style={{ ${c.position}, boxSizing: 'border-box', ${style} }}>`;
}

// ---- layout ---------------------------------------------------------------------

function columns(c: ElementContext): string {
  const titles = parts(c.label);
  const panels = (titles.length > 0 ? titles : ['Column 1', 'Column 2', 'Column 3'])
    .map((title) => `<div style={{ flex: 1, border: '1px dashed ${c.line}', borderRadius: 10, padding: 16, color: '${c.muted}', fontSize: 14 }}>${c.text(title)}</div>`)
    .join('');
  return `${head('div', c, `display: 'flex', gap: 24`)}${panels}</div>`;
}

function spacer(c: ElementContext): string {
  return `<div data-testid="${c.id}" aria-hidden="true" style={{ ${c.position} }} />`;
}

// ---- navigation -------------------------------------------------------------------

function sidebar(c: ElementContext): string {
  const [brand = 'Brand', ...items] = parts(c.label);
  const links = items
    .map((item, i) => `<a href="#" style={{ display: 'block', padding: '10px 14px', borderRadius: 8, textDecoration: 'none', fontSize: 14, color: '${i === 0 ? '#ffffff' : c.ink}', backgroundColor: '${i === 0 ? c.color : 'transparent'}' }}>${c.text(item)}</a>`)
    .join('');
  return `${head('nav', c, `backgroundColor: '${c.surface}', borderRight: '1px solid ${c.line}', padding: 16, display: 'flex', flexDirection: 'column', gap: 4`)}<strong style={{ fontSize: 18, color: '${c.ink}', padding: '4px 14px 16px' }}>${c.text(brand)}</strong>${links}</nav>`;
}

function mobileMenu(c: ElementContext): string {
  const [brand = 'Brand', ...items] = parts(c.label);
  const links = items.map((item) => `<a href="#" style={{ padding: '12px 4px', color: '${c.ink}', textDecoration: 'none', borderBottom: '1px solid ${c.line}' }}>${c.text(item)}</a>`).join('');
  return `${head('div', c, `display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', backgroundColor: '${c.surface}', borderBottom: '1px solid ${c.line}'`)}<strong style={{ color: '${c.ink}' }}>${c.text(brand)}</strong><details className="vb-menu"><summary aria-label="Menu" style={{ fontSize: 24, color: '${c.color}' }}>☰</summary><div className="vb-drawer" style={{ backgroundColor: '${c.surface}', borderLeft: '1px solid ${c.line}' }}>${links}</div></details></div>`;
}

function dropdownMenu(c: ElementContext): string {
  const [label = 'Menu', ...items] = parts(c.label);
  const links = items.map((item) => `<a href="#" style={{ padding: '8px 14px', color: '${c.ink}', textDecoration: 'none', fontSize: 14 }}>${c.text(item)}</a>`).join('');
  return `${head('details', c, `zIndex: 5`, ' className="vb-menu"')}<summary style={{ display: 'inline-flex', alignItems: 'center', gap: 6, backgroundColor: '${c.color}', color: '#ffffff', borderRadius: 8, padding: '8px 14px' }}>${c.text(label)} ▾</summary><div className="vb-menu-panel" style={{ backgroundColor: '${c.surface}', border: '1px solid ${c.line}' }}>${links}</div></details>`;
}

// ---- overlays -------------------------------------------------------------------------

function modal(c: ElementContext): string {
  const [trigger = 'Open', title = 'Dialog', body = ''] = parts(c.label);
  return `${head('div', c, `display: 'flex', alignItems: 'center'`)}<VbModal trigger={${JSON.stringify(trigger)}} title={${JSON.stringify(title)}} body={${JSON.stringify(body)}} color="${c.color}" surface="${c.surface}" ink="${c.ink}" muted="${c.muted}" /></div>`;
}

function tooltip(c: ElementContext): string {
  const [text = 'Hover me', tip = ''] = parts(c.label);
  return `${head('span', c, `display: 'inline-flex', alignItems: 'center', color: '${c.color}', textDecoration: 'underline dotted', cursor: 'help'`, ` className="vb-tip" data-tip="${c.attr(tip)}"`)}${c.text(text)}</span>`;
}

function toast(c: ElementContext): string {
  return `<div data-testid="${c.id}" role="status" className="vb-toast" style={{ position: 'fixed', left: 24, bottom: 24, zIndex: 60, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', borderRadius: 10, backgroundColor: '${c.surface}', color: '${c.ink}', borderLeft: '4px solid ${c.color}', boxShadow: '0 10px 30px rgba(0, 0, 0, 0.2)', fontSize: 14 }}>${c.text(c.label)}</div>`;
}

// ---- page-level ---------------------------------------------------------------------

function backToTop(c: ElementContext): string {
  return `<button type="button" data-testid="${c.id}" aria-label="Back to top" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} style={{ position: 'fixed', right: 24, bottom: 88, zIndex: 50, width: 44, height: 44, borderRadius: '50%', border: 'none', backgroundColor: '${c.color}', color: '#ffffff', fontSize: 18, cursor: 'pointer', boxShadow: '0 6px 18px rgba(0, 0, 0, 0.2)' }}>${c.text(c.label || '↑')}</button>`;
}

function scrollProgress(c: ElementContext): string {
  // display: contents - the bar is fixed to the window; the wrapper only carries the element's id.
  return `<div data-testid="${c.id}" style={{ display: 'contents' }}><VbScrollProgress color="${c.color}" /></div>`;
}

function fab(c: ElementContext): string {
  return `<button type="button" data-testid="${c.id}" aria-label="${c.attr(c.label || 'Action')}" style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 50, width: 56, height: 56, borderRadius: '50%', border: 'none', backgroundColor: '${c.color}', color: '#ffffff', fontSize: 26, cursor: 'pointer', boxShadow: '0 10px 24px rgba(0, 0, 0, 0.25)' }}>${c.text(c.label || '+')}</button>`;
}

function cookieBanner(c: ElementContext): string {
  const [text = 'We use cookies.', accept = 'Accept'] = parts(c.label);
  return `<div data-testid="${c.id}" style={{ display: 'contents' }}><VbCookieBanner text={${JSON.stringify(text)}} accept={${JSON.stringify(accept)}} color="${c.color}" surface="${c.surface}" ink="${c.ink}" /></div>`;
}

export const WIDGET_RENDERERS: Readonly<Record<WidgetType, (c: ElementContext) => string>> = {
  columns,
  spacer,
  sidebar,
  'mobile-menu': mobileMenu,
  modal,
  tooltip,
  'dropdown-menu': dropdownMenu,
  toast,
  'back-to-top': backToTop,
  'scroll-progress': scrollProgress,
  fab,
  'cookie-banner': cookieBanner,
};

// ---- runtime --------------------------------------------------------------------

const HELPERS: Readonly<Partial<Record<WidgetType, readonly string[]>>> = {
  modal: [
    'function VbModal(props: { readonly trigger: string; readonly title: string; readonly body: string; readonly color: string; readonly surface: string; readonly ink: string; readonly muted: string }) {',
    '  const [open, setOpen] = useState(false);',
    '  return (',
    '    <>',
    "      <button type=\"button\" onClick={() => setOpen(true)} style={{ backgroundColor: props.color, color: '#ffffff', border: 'none', borderRadius: 8, padding: '10px 18px', cursor: 'pointer' }}>{props.trigger}</button>",
    '      {open && (',
    "        <div role=\"dialog\" aria-modal=\"true\" onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 100, backgroundColor: 'rgba(0, 0, 0, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>",
    "          <div onClick={(event) => event.stopPropagation()} style={{ width: 'min(480px, 90vw)', backgroundColor: props.surface, color: props.ink, borderRadius: 14, padding: 24, boxShadow: '0 24px 60px rgba(0, 0, 0, 0.35)' }}>",
    "            <h3 style={{ margin: '0 0 8px' }}>{props.title}</h3>",
    "            <p style={{ margin: '0 0 20px', color: props.muted, lineHeight: 1.5 }}>{props.body}</p>",
    "            <button type=\"button\" onClick={() => setOpen(false)} style={{ backgroundColor: props.color, color: '#ffffff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}>Close</button>",
    '          </div>',
    '        </div>',
    '      )}',
    '    </>',
    '  );',
    '}',
  ],
  'scroll-progress': [
    'function VbScrollProgress({ color }: { readonly color: string }) {',
    '  const [progress, setProgress] = useState(0);',
    '  useEffect(() => {',
    '    const update = () => {',
    '      const max = document.documentElement.scrollHeight - window.innerHeight;',
    '      setProgress(max > 0 ? window.scrollY / max : 0);',
    '    };',
    '    update();',
    "    window.addEventListener('scroll', update, { passive: true });",
    "    return () => window.removeEventListener('scroll', update);",
    '  }, []);',
    "  return <div aria-hidden=\"true\" style={{ position: 'fixed', top: 0, left: 0, height: 3, zIndex: 90, width: `${progress * 100}%`, backgroundColor: color }} />;",
    '}',
  ],
  'cookie-banner': [
    'function VbCookieBanner(props: { readonly text: string; readonly accept: string; readonly color: string; readonly surface: string; readonly ink: string }) {',
    '  const [visible, setVisible] = useState(false);',
    '  useEffect(() => {',
    "    setVisible(window.localStorage.getItem('vb-cookies') !== 'accepted');",
    '  }, []);',
    '  if (!visible) return null;',
    '  return (',
    "    <div role=\"region\" aria-label=\"Cookie consent\" style={{ position: 'fixed', left: 16, right: 16, bottom: 16, zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 18px', borderRadius: 12, backgroundColor: props.surface, color: props.ink, boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)' }}>",
    '      <span style={{ fontSize: 14 }}>{props.text}</span>',
    "      <button type=\"button\" onClick={() => { window.localStorage.setItem('vb-cookies', 'accepted'); setVisible(false); }} style={{ backgroundColor: props.color, color: '#ffffff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}>{props.accept}</button>",
    '    </div>',
    '  );',
    '}',
  ],
};

const CSS: Readonly<Partial<Record<WidgetType, readonly string[]>>> = {
  tooltip: [
    '.vb-tip::after { content: attr(data-tip); position: absolute; left: 50%; bottom: calc(100% + 8px); transform: translateX(-50%); white-space: nowrap; padding: 6px 10px; border-radius: 6px; background: #111827; color: #ffffff; font-size: 12px; opacity: 0; pointer-events: none; transition: opacity 150ms; z-index: 20; }',
    '.vb-tip:hover::after { opacity: 1; }',
  ],
  'dropdown-menu': [
    '.vb-menu > summary { list-style: none; cursor: pointer; }',
    '.vb-menu > summary::-webkit-details-marker { display: none; }',
    '.vb-menu-panel { position: absolute; top: calc(100% + 6px); left: 0; min-width: 180px; display: flex; flex-direction: column; border-radius: 10px; padding: 6px 0; box-shadow: 0 12px 30px rgba(0, 0, 0, 0.18); }',
  ],
  'mobile-menu': [
    '.vb-menu > summary { list-style: none; cursor: pointer; }',
    '.vb-menu > summary::-webkit-details-marker { display: none; }',
    '.vb-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(300px, 80vw); z-index: 70; display: flex; flex-direction: column; padding: 56px 20px 20px; box-shadow: -12px 0 40px rgba(0, 0, 0, 0.25); }',
  ],
  toast: [
    '@keyframes vb-toast { 0% { opacity: 0; transform: translateY(16px); } 8%, 85% { opacity: 1; transform: none; } 100% { opacity: 0; transform: translateY(16px); visibility: hidden; } }',
    '.vb-toast { animation: vb-toast 5s ease 0.6s both; }',
  ],
};

export interface WidgetRuntime {
  readonly values: readonly string[];
  readonly helpers: string;
  readonly css: readonly string[];
}

export function widgetRuntime(types: ReadonlySet<string>): WidgetRuntime {
  const used = WIDGET_TYPES.filter((type) => types.has(type));
  const helpers = used.flatMap((type) => (HELPERS[type] === undefined ? [] : [(HELPERS[type] ?? []).join('\n')]));
  const needsEffect = used.some((type) => type === 'scroll-progress' || type === 'cookie-banner');
  const needsState = helpers.length > 0;
  // dropdown-menu and mobile-menu share their summary rules; emit each rule once.
  const css = [...new Set(used.flatMap((type) => CSS[type] ?? []))];
  return {
    values: [...(needsEffect ? ['useEffect'] : []), ...(needsState ? ['useState'] : [])],
    helpers: helpers.join('\n\n'),
    css,
  };
}
