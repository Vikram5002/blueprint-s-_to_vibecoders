/**
 * The Page Builder's extended element catalogue: the building blocks a
 * website builder (Lovable, Webflow, Framer) offers beyond the twelve basic
 * controls in canvas-layout.ts - page sections, navigation, cards, pricing,
 * tables, tabs, media, and more form controls.
 *
 * Same posture as the basic set: a fixed, closed list, each type rendered by
 * one deterministic template from the element's position, color token and
 * label - no model call, no free-form CSS. Elements that need several pieces
 * of text take them from the label separated by `|` (a navbar's
 * "Brand|Home|Pricing|Contact"); a table's rows are `|`-separated and its
 * cells `,`-separated. Every piece of user text is escaped for the place it
 * lands in, and URLs are accepted only as http(s).
 *
 * Imports nothing from canvas-layout.ts, which imports this: the renderers
 * receive everything they need in an `ElementContext`.
 */

export const EXTENDED_ELEMENT_TYPES = [
  // Layout
  'section', 'card', 'navbar', 'hero', 'footer',
  // Typography
  'paragraph', 'quote', 'code', 'list', 'badge',
  // Media
  'video', 'icon', 'avatar',
  // Forms
  'email', 'password', 'number', 'date', 'search', 'toggle', 'slider', 'file', 'rating',
  // Data display
  'table', 'stat', 'progress', 'pricing', 'testimonial',
  // Navigation
  'tabs', 'breadcrumb', 'pagination',
  // Feedback
  'alert', 'accordion', 'spinner',
] as const;

export type ExtendedElementType = (typeof EXTENDED_ELEMENT_TYPES)[number];

const EXTENDED: ReadonlySet<string> = new Set(EXTENDED_ELEMENT_TYPES);

export function isExtendedElementType(type: string): type is ExtendedElementType {
  return EXTENDED.has(type);
}

export interface ElementContext {
  readonly id: string;
  /** The shared absolute-position (and animation) style entries, without braces. */
  readonly position: string;
  /** The element's design-token hex color. */
  readonly color: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  /** Escapes text placed as JSX children. */
  readonly text: (value: string) => string;
  /** Escapes text placed inside a double-quoted JSX attribute. */
  readonly attr: (value: string) => string;
}

/** Keyframes an extended element needs regardless of the animation picker (the spinner spins). */
export const SPIN_KEYFRAMES = '@keyframes vb-spin { to { transform: rotate(360deg); } }';

const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#e2e8f0';

function parts(label: string): string[] {
  return label.split('|').map((part) => part.trim()).filter((part) => part !== '');
}

function httpUrl(value: string): string | null {
  return /^https?:\/\/[^\s"'<>]+$/i.test(value.trim()) ? value.trim() : null;
}

function open(tag: string, c: ElementContext, style: string, extra = ''): string {
  return `<${tag}${extra} data-testid="${c.id}" style={{ ${c.position}, boxSizing: 'border-box', ${style} }}>`;
}

// ---- Layout -----------------------------------------------------------------

function section(c: ElementContext): string {
  return `${open('section', c, `backgroundColor: '${c.color}14', borderRadius: 12`, ` aria-label="${c.attr(c.label)}"`)}</section>`;
}

function card(c: ElementContext): string {
  const [title = 'Card title', body = '', action] = parts(c.label);
  const style = `background: '#ffffff', border: '1px solid ${LINE}', borderRadius: 12, boxShadow: '0 4px 14px rgba(15, 23, 42, 0.08)', padding: 20, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden'`;
  const button = action === undefined ? '' : `<button type="button" style={{ alignSelf: 'flex-start', backgroundColor: '${c.color}', color: '#ffffff', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer' }}>${c.text(action)}</button>`;
  return `${open('div', c, style)}<h3 style={{ margin: 0, fontSize: 18, color: '${INK}' }}>${c.text(title)}</h3><p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: '#475569', flex: 1 }}>${c.text(body)}</p>${button}</div>`;
}

function navbar(c: ElementContext): string {
  const [brand = 'Brand', ...links] = parts(c.label);
  const anchors = links.map((link) => `<a href="#" style={{ color: '#ffffff', textDecoration: 'none', fontSize: 14 }}>${c.text(link)}</a>`).join('');
  const style = `backgroundColor: '${c.color}', color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px'`;
  return `${open('nav', c, style)}<strong style={{ fontSize: 18 }}>${c.text(brand)}</strong><div style={{ display: 'flex', gap: 24 }}>${anchors}</div></nav>`;
}

function hero(c: ElementContext): string {
  const [title = 'Build something great', subtitle = '', action] = parts(c.label);
  const style = `background: 'linear-gradient(135deg, ${c.color}, ${c.color}bb)', color: '#ffffff', borderRadius: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32, textAlign: 'center'`;
  const button = action === undefined ? '' : `<button type="button" style={{ backgroundColor: '#ffffff', color: '${c.color}', border: 'none', borderRadius: 999, padding: '12px 28px', fontSize: 16, fontWeight: 600, cursor: 'pointer' }}>${c.text(action)}</button>`;
  return `${open('section', c, style)}<h1 style={{ margin: 0, fontSize: 44, lineHeight: 1.1 }}>${c.text(title)}</h1><p style={{ margin: 0, fontSize: 18, opacity: 0.9, maxWidth: 640 }}>${c.text(subtitle)}</p>${button}</section>`;
}

function footer(c: ElementContext): string {
  const [note = '', ...links] = parts(c.label);
  const anchors = links.map((link) => `<a href="#" style={{ color: '#cbd5e1', textDecoration: 'none' }}>${c.text(link)}</a>`).join('');
  const style = `backgroundColor: '${INK}', color: '#cbd5e1', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', fontSize: 14, borderTop: '3px solid ${c.color}'`;
  return `${open('footer', c, style)}<span>${c.text(note)}</span><div style={{ display: 'flex', gap: 20 }}>${anchors}</div></footer>`;
}

// ---- Typography -------------------------------------------------------------

function paragraph(c: ElementContext): string {
  return `${open('p', c, `margin: 0, color: '${c.color}', fontSize: 16, lineHeight: 1.6, overflow: 'hidden'`)}${c.text(c.label)}</p>`;
}

function quote(c: ElementContext): string {
  const [text = '', author] = parts(c.label);
  const cite = author === undefined ? '' : `<footer style={{ marginTop: 8, fontSize: 14, fontStyle: 'normal', color: '${MUTED}' }}>— ${c.text(author)}</footer>`;
  return `${open('blockquote', c, `margin: 0, borderLeft: '4px solid ${c.color}', paddingLeft: 16, fontStyle: 'italic', fontSize: 18, color: '#334155'`)}${c.text(text)}${cite}</blockquote>`;
}

function code(c: ElementContext): string {
  const source = JSON.stringify(parts(c.label).join('\n'));
  return `${open('pre', c, `margin: 0, backgroundColor: '${INK}', color: '#e2e8f0', borderTop: '3px solid ${c.color}', borderRadius: 8, padding: 12, fontSize: 13, overflow: 'auto'`)}<code>{${source}}</code></pre>`;
}

function list(c: ElementContext): string {
  const items = parts(c.label).map((item) => `<li>${c.text(item)}</li>`).join('');
  return `${open('ul', c, `margin: 0, paddingLeft: 20, color: '${c.color}', fontSize: 16, lineHeight: 1.8`)}${items}</ul>`;
}

function badge(c: ElementContext): string {
  return `${open('span', c, `display: 'inline-flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '${c.color}1f', color: '${c.color}', borderRadius: 999, fontSize: 12, fontWeight: 600`)}${c.text(c.label)}</span>`;
}

// ---- Media ------------------------------------------------------------------

function youtubeId(url: string): string | null {
  const match = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/.exec(url);
  return match?.[1] ?? null;
}

function video(c: ElementContext): string {
  const url = httpUrl(c.label);
  const youtube = url === null ? null : youtubeId(url);
  if (youtube !== null) {
    return `<iframe data-testid="${c.id}" title="Video" src="https://www.youtube-nocookie.com/embed/${youtube}" allowFullScreen style={{ ${c.position}, border: 'none', borderRadius: 8 }} />`;
  }
  if (url !== null) {
    return `<video data-testid="${c.id}" src="${c.attr(url)}" controls style={{ ${c.position}, borderRadius: 8, backgroundColor: '#000000' }} />`;
  }
  return `${open('div', c, `backgroundColor: '${INK}', color: '#ffffff', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, border: '2px solid ${c.color}'`, ' role="img"')}<span style={{ fontSize: 28, color: '${c.color}' }}>▶</span>${c.text(c.label)}</div>`;
}

function icon(c: ElementContext): string {
  const size = Math.max(12, Math.round(Math.min(c.width, c.height) * 0.5));
  return `${open('span', c, `display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', backgroundColor: '${c.color}1f', color: '${c.color}', fontSize: ${size}`, ' role="img"')}${c.text(c.label)}</span>`;
}

function avatar(c: ElementContext): string {
  const initials = parts(c.label).join(' ').split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join('');
  const size = Math.max(10, Math.round(Math.min(c.width, c.height) * 0.4));
  return `${open('span', c, `display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', backgroundColor: '${c.color}', color: '#ffffff', fontWeight: 600, fontSize: ${size}`, ` role="img" aria-label="${c.attr(c.label)}"`)}${c.text(initials)}</span>`;
}

// ---- Forms ------------------------------------------------------------------

function typedInput(type: string): (c: ElementContext) => string {
  return (c) =>
    `<input type="${type}" data-testid="${c.id}" placeholder="${c.attr(c.label)}" aria-label="${c.attr(c.label)}" style={{ ${c.position}, border: '1px solid ${c.color}', borderRadius: 8, boxSizing: 'border-box', padding: '0 12px', fontSize: 14 }} />`;
}

function toggle(c: ElementContext): string {
  return `${open('label', c, `display: 'flex', alignItems: 'center', gap: 10, color: '${INK}', fontSize: 14, cursor: 'pointer'`)}<input type="checkbox" role="switch" style={{ accentColor: '${c.color}', width: 36, height: 20 }} />${c.text(c.label)}</label>`;
}

function slider(c: ElementContext): string {
  return `<input type="range" data-testid="${c.id}" aria-label="${c.attr(c.label)}" style={{ ${c.position}, accentColor: '${c.color}' }} />`;
}

function file(c: ElementContext): string {
  return `${open('label', c, `border: '2px dashed ${c.color}', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '${c.color}', fontSize: 14, cursor: 'pointer'`)}${c.text(c.label)}<input type="file" style={{ display: 'none' }} /></label>`;
}

function rating(c: ElementContext): string {
  const [score = '4', caption] = parts(c.label);
  const filled = Math.min(5, Math.max(0, Math.round(Number(score) || 0)));
  const stars = '★'.repeat(filled) + '☆'.repeat(5 - filled);
  const text = caption === undefined ? '' : `<span style={{ marginLeft: 8, fontSize: 14, color: '${MUTED}' }}>${c.text(caption)}</span>`;
  return `${open('div', c, `display: 'flex', alignItems: 'center', color: '${c.color}', fontSize: 20, letterSpacing: 2`, ` aria-label="${filled} out of 5"`)}${stars}${text}</div>`;
}

// ---- Data display -----------------------------------------------------------

function table(c: ElementContext): string {
  const [header = [], ...rows] = parts(c.label).map((row) => row.split(',').map((cell) => cell.trim()));
  const th = header.map((cell) => `<th style={{ textAlign: 'left', padding: '8px 12px', backgroundColor: '${c.color}', color: '#ffffff' }}>${c.text(cell)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td style={{ padding: '8px 12px', borderBottom: '1px solid ${LINE}', color: '#334155' }}>${c.text(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `${open('table', c, `borderCollapse: 'collapse', fontSize: 14, backgroundColor: '#ffffff', overflow: 'hidden', borderRadius: 8`)}<thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

function stat(c: ElementContext): string {
  const [value = '0', caption = ''] = parts(c.label);
  return `${open('div', c, `display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 16, border: '1px solid ${LINE}', borderRadius: 12, backgroundColor: '#ffffff'`)}<strong style={{ fontSize: 32, color: '${c.color}' }}>${c.text(value)}</strong><span style={{ fontSize: 14, color: '${MUTED}' }}>${c.text(caption)}</span></div>`;
}

function progress(c: ElementContext): string {
  const [value = '50', caption = ''] = parts(c.label);
  const percent = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
  return `${open('div', c, `display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6, fontSize: 13, color: '${INK}'`, ` role="progressbar" aria-valuenow={${percent}} aria-valuemin={0} aria-valuemax={100}`)}<span>${c.text(caption)} ${percent}%</span><div style={{ height: 8, borderRadius: 999, backgroundColor: '${LINE}', overflow: 'hidden' }}><div style={{ width: '${percent}%', height: '100%', backgroundColor: '${c.color}' }} /></div></div>`;
}

function pricing(c: ElementContext): string {
  const [plan = 'Pro', price = '$0', ...features] = parts(c.label);
  const items = features.map((feature) => `<li>✓ ${c.text(feature)}</li>`).join('');
  const style = `background: '#ffffff', border: '2px solid ${c.color}', borderRadius: 16, padding: 24, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden'`;
  return `${open('div', c, style)}<span style={{ fontSize: 14, fontWeight: 600, color: '${c.color}', textTransform: 'uppercase' }}>${c.text(plan)}</span><strong style={{ fontSize: 36, color: '${INK}' }}>${c.text(price)}</strong><ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', lineHeight: 1.9, fontSize: 14, color: '#334155', flex: 1 }}>${items}</ul><button type="button" style={{ backgroundColor: '${c.color}', color: '#ffffff', border: 'none', borderRadius: 8, padding: '10px 0', fontSize: 15, cursor: 'pointer' }}>Get started</button></div>`;
}

function testimonial(c: ElementContext): string {
  const [text = '', author = '', role = ''] = parts(c.label);
  const style = `background: '#ffffff', border: '1px solid ${LINE}', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden'`;
  return `${open('figure', c, `margin: 0, ${style}`)}<blockquote style={{ margin: 0, fontSize: 16, lineHeight: 1.5, color: '#334155' }}>“${c.text(text)}”</blockquote><figcaption style={{ fontSize: 14 }}><strong style={{ color: '${c.color}' }}>${c.text(author)}</strong> <span style={{ color: '${MUTED}' }}>${c.text(role)}</span></figcaption></figure>`;
}

// ---- Navigation -------------------------------------------------------------

function tabs(c: ElementContext): string {
  const items = parts(c.label)
    .map((tab, index) => {
      const active = index === 0 ? `color: '${c.color}', borderBottom: '2px solid ${c.color}', fontWeight: 600` : `color: '${MUTED}', borderBottom: '2px solid transparent'`;
      return `<button type="button" role="tab" style={{ background: 'none', border: 'none', padding: '8px 4px', cursor: 'pointer', fontSize: 14, ${active} }}>${c.text(tab)}</button>`;
    })
    .join('');
  return `${open('div', c, `display: 'flex', alignItems: 'flex-end', gap: 20, borderBottom: '1px solid ${LINE}'`, ' role="tablist"')}${items}</div>`;
}

function breadcrumb(c: ElementContext): string {
  const crumbs = parts(c.label);
  const items = crumbs
    .map((crumb, index) =>
      index === crumbs.length - 1
        ? `<span style={{ color: '${INK}', fontWeight: 600 }}>${c.text(crumb)}</span>`
        : `<a href="#" style={{ color: '${c.color}', textDecoration: 'none' }}>${c.text(crumb)}</a><span style={{ color: '${MUTED}' }}>/</span>`,
    )
    .join('');
  return `${open('nav', c, `display: 'flex', alignItems: 'center', gap: 8, fontSize: 14`, ' aria-label="Breadcrumb"')}${items}</nav>`;
}

function pagination(c: ElementContext): string {
  const pages = Math.min(9, Math.max(1, Math.round(Number(c.label) || 3)));
  const cell = (text: string, active: boolean): string =>
    `<button type="button" style={{ minWidth: 32, height: 32, borderRadius: 8, cursor: 'pointer', fontSize: 14, border: '1px solid ${active ? c.color : LINE}', backgroundColor: '${active ? c.color : '#ffffff'}', color: '${active ? '#ffffff' : INK}' }}>${text}</button>`;
  const numbers = Array.from({ length: pages }, (_unused, index) => cell(String(index + 1), index === 0)).join('');
  return `${open('nav', c, `display: 'flex', alignItems: 'center', gap: 6`, ' aria-label="Pagination"')}${cell('‹', false)}${numbers}${cell('›', false)}</nav>`;
}

// ---- Feedback ---------------------------------------------------------------

function alert(c: ElementContext): string {
  return `${open('div', c, `display: 'flex', alignItems: 'center', padding: '0 16px', backgroundColor: '${c.color}14', borderLeft: '4px solid ${c.color}', borderRadius: 8, color: '${c.color}', fontSize: 14`, ' role="alert"')}${c.text(c.label)}</div>`;
}

function accordion(c: ElementContext): string {
  const [title = 'Question', body = ''] = parts(c.label);
  return `${open('details', c, `border: '1px solid ${LINE}', borderRadius: 10, padding: '12px 16px', backgroundColor: '#ffffff', overflow: 'hidden'`)}<summary style={{ cursor: 'pointer', fontWeight: 600, color: '${c.color}' }}>${c.text(title)}</summary><p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.5, color: '#475569' }}>${c.text(body)}</p></details>`;
}

function spinner(c: ElementContext): string {
  const size = Math.min(c.width, c.height);
  return `<div data-testid="${c.id}" role="status" aria-label="${c.attr(c.label || 'Loading')}" style={{ ${c.position}, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div style={{ width: ${size}, height: ${size}, boxSizing: 'border-box', borderRadius: '50%', border: '4px solid ${c.color}33', borderTopColor: '${c.color}', animation: 'vb-spin 0.8s linear infinite' }} /></div>`;
}

const RENDERERS: Readonly<Record<ExtendedElementType, (c: ElementContext) => string>> = {
  section, card, navbar, hero, footer,
  paragraph, quote, code, list, badge,
  video, icon, avatar,
  email: typedInput('email'), password: typedInput('password'), number: typedInput('number'), date: typedInput('date'), search: typedInput('search'),
  toggle, slider, file, rating,
  table, stat, progress, pricing, testimonial,
  tabs, breadcrumb, pagination,
  alert, accordion, spinner,
};

export function renderExtendedElement(type: ExtendedElementType, context: ElementContext): string {
  return RENDERERS[type](context);
}

/** Renders a real image when the label is an http(s) URL; null means "use the placeholder". */
export function renderImageFromUrl(context: ElementContext): string | null {
  const url = httpUrl(context.label);
  if (url === null) return null;
  return `<img data-testid="${context.id}" src="${context.attr(url)}" alt="" style={{ ${context.position}, objectFit: 'cover', borderRadius: 4 }} />`;
}
