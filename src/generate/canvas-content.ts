/**
 * Page Builder content and data blocks: media (carousel, gallery, lightbox,
 * before/after, map, embed, audio, Lottie), marketing blocks (feature grid,
 * FAQ, CTA, logo cloud, team, blog and product cards, social icons), data
 * display (bar/line/pie charts, description list, tree, kanban, calendar,
 * timeline, stepper, kbd, skeleton, empty state, countdown) and a QR code.
 *
 * Deterministic: charts, calendar and QR code are computed at generation time
 * into plain SVG/markup; only genuinely interactive blocks get a small React
 * helper, emitted when used. Media URLs must be http(s); anything else falls
 * back to a labelled placeholder, never a fabricated source.
 */
import type { ElementContext } from './canvas-elements.js';
import { qrMatrix } from './qr.js';
import { mix } from './svg-backgrounds.js';

export const CONTENT_TYPES = [
  'carousel', 'gallery', 'lightbox', 'before-after', 'map', 'embed', 'custom-html', 'audio', 'lottie',
  'social-icons', 'logo-cloud', 'feature-grid', 'faq-list', 'cta-banner', 'team-card', 'blog-card', 'product-card',
  'bar-chart', 'line-chart', 'pie-chart', 'description-list', 'tree-view', 'kanban', 'calendar', 'timeline',
  'stepper', 'kbd', 'skeleton', 'empty-state', 'countdown', 'qr-code',
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

function parts(label: string): string[] {
  return label.split('|').map((part) => part.trim()).filter((part) => part !== '');
}

function isUrl(value: string | undefined): value is string {
  return value !== undefined && /^https?:\/\/[^\s"'<>]+$/i.test(value.trim());
}

function head(tag: string, c: ElementContext, style: string, extra = ''): string {
  return `<${tag}${extra} data-testid="${c.id}" style={{ ${c.position}, boxSizing: 'border-box', ${style} }}>`;
}

const js = (value: unknown): string => JSON.stringify(value);

// ---- media ----------------------------------------------------------------------

function carousel(c: ElementContext): string {
  const slides = parts(c.label).map((part) => (isUrl(part) ? { image: part, text: '' } : { image: '', text: part }));
  return `${head('div', c, `overflow: 'hidden', borderRadius: 14`)}<VbCarousel slides={${js(slides)}} color="${c.color}" /></div>`;
}

function gallery(c: ElementContext): string {
  const images = parts(c.label).map((part) => (isUrl(part) ? part : ''));
  return `${head('div', c, `display: 'flex'`)}<VbGallery images={${js(images)}} color="${c.color}" line="${c.line}" /></div>`;
}

function lightbox(c: ElementContext): string {
  const url = parts(c.label)[0];
  return `${head('div', c, `display: 'flex'`)}<VbGallery images={${js([isUrl(url) ? url : ''])}} color="${c.color}" line="${c.line}" /></div>`;
}

function beforeAfter(c: ElementContext): string {
  const [before, after] = parts(c.label);
  return `${head('div', c, `overflow: 'hidden', borderRadius: 12`)}<VbCompare before={${js(isUrl(before) ? before : '')}} after={${js(isUrl(after) ? after : '')}} color="${c.color}" /></div>`;
}

function map(c: ElementContext): string {
  const query = encodeURIComponent(c.label.trim() || 'Mumbai');
  return `<iframe data-testid="${c.id}" title="Map" loading="lazy" src="https://maps.google.com/maps?q=${query}&output=embed" style={{ ${c.position}, border: 'none', borderRadius: 12 }} />`;
}

function embed(c: ElementContext): string {
  const url = c.label.trim();
  if (!isUrl(url)) return `${head('div', c, `border: '2px dashed ${c.line}', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '${c.muted}'`)}Embed: paste an https:// URL</div>`;
  return `<iframe data-testid="${c.id}" title="Embedded content" loading="lazy" src="${c.attr(url)}" style={{ ${c.position}, border: 'none', borderRadius: 12 }} />`;
}

function customHtml(c: ElementContext): string {
  // Inserted exactly as typed: for trusted snippets only (the Inspector says so).
  return `<div data-testid="${c.id}" style={{ ${c.position}, boxSizing: 'border-box', overflow: 'auto' }} dangerouslySetInnerHTML={{ __html: ${js(c.label)} }} />`;
}

function audio(c: ElementContext): string {
  const [url, title = 'Audio'] = parts(c.label);
  if (!isUrl(url)) return `${head('div', c, `display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', borderRadius: 12, backgroundColor: '${c.surface}', border: '1px solid ${c.line}', color: '${c.muted}'`)}♪ ${c.text(title)} - paste an https:// audio URL</div>`;
  return `${head('div', c, `display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6`)}<span style={{ fontSize: 14, fontWeight: 600, color: '${c.ink}' }}>${c.text(title)}</span><audio controls preload="none" src="${c.attr(url)}" style={{ width: '100%' }} /></div>`;
}

function lottie(c: ElementContext): string {
  const url = c.label.trim();
  return `${head('div', c, `display: 'flex', alignItems: 'center', justifyContent: 'center'`)}<VbLottie src={${js(isUrl(url) ? url : '')}} muted="${c.muted}" /></div>`;
}

// ---- marketing ------------------------------------------------------------------

const SOCIAL: Readonly<Record<string, { readonly glyph: string; readonly url: string }>> = {
  x: { glyph: '𝕏', url: 'https://x.com' },
  twitter: { glyph: '𝕏', url: 'https://x.com' },
  github: { glyph: 'GH', url: 'https://github.com' },
  linkedin: { glyph: 'in', url: 'https://linkedin.com' },
  instagram: { glyph: 'IG', url: 'https://instagram.com' },
  youtube: { glyph: '▶', url: 'https://youtube.com' },
  facebook: { glyph: 'f', url: 'https://facebook.com' },
  whatsapp: { glyph: 'WA', url: 'https://wa.me' },
};

function socialIcons(c: ElementContext): string {
  const links = parts(c.label)
    .map((name) => {
      const known = SOCIAL[name.toLowerCase()];
      const href = isUrl(name) ? name : known?.url ?? '#';
      const glyph = known?.glyph ?? name.slice(0, 2).toUpperCase();
      return `<a href="${c.attr(href)}" aria-label="${c.attr(name)}" target="_blank" rel="noreferrer" style={{ width: 40, height: 40, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '${c.color}', color: '#ffffff', textDecoration: 'none', fontWeight: 700, fontSize: 14 }}>${c.text(glyph)}</a>`;
    })
    .join('');
  return `${head('div', c, `display: 'flex', alignItems: 'center', gap: 10`)}${links}</div>`;
}

function logoCloud(c: ElementContext): string {
  const logos = parts(c.label).map((name) => `<span style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.5, color: '${c.muted}', opacity: 0.8 }}>${c.text(name)}</span>`).join('');
  return `${head('div', c, `display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-around', gap: 24`)}${logos}</div>`;
}

function featureGrid(c: ElementContext): string {
  const items = parts(c.label);
  const cells: string[] = [];
  for (let i = 0; i + 2 < items.length + 1; i += 3) {
    const [icon = '★', title = '', text = ''] = items.slice(i, i + 3);
    cells.push(`<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ width: 40, height: 40, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '${c.color}22', color: '${c.color}', fontSize: 20 }}>${c.text(icon)}</span><strong style={{ fontSize: 16, color: '${c.ink}' }}>${c.text(title)}</strong><span style={{ fontSize: 14, lineHeight: 1.5, color: '${c.muted}' }}>${c.text(text)}</span></div>`);
  }
  return `${head('div', c, `display: 'grid', gridTemplateColumns: 'repeat(${Math.min(4, Math.max(1, cells.length))}, 1fr)', gap: 24`)}${cells.join('')}</div>`;
}

function faqList(c: ElementContext): string {
  const items = parts(c.label);
  const entries: string[] = [];
  for (let i = 0; i < items.length; i += 2) {
    entries.push(`<details style={{ borderBottom: '1px solid ${c.line}', padding: '12px 0' }}><summary style={{ cursor: 'pointer', fontWeight: 600, color: '${c.ink}' }}>${c.text(items[i] ?? '')}</summary><p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.6, color: '${c.muted}' }}>${c.text(items[i + 1] ?? '')}</p></details>`);
  }
  return `${head('div', c, `display: 'flex', flexDirection: 'column'`)}${entries.join('')}</div>`;
}

function ctaBanner(c: ElementContext): string {
  const [title = 'Ready to start?', text = '', action = 'Get started'] = parts(c.label);
  return `${head('section', c, `display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, padding: '24px 32px', borderRadius: 16, background: 'linear-gradient(120deg, ${c.color}, ${c.color}cc)', color: '#ffffff'`)}<div><h2 style={{ margin: 0, fontSize: 26 }}>${c.text(title)}</h2><p style={{ margin: '6px 0 0', opacity: 0.9 }}>${c.text(text)}</p></div><a href="#" style={{ backgroundColor: '#ffffff', color: '${c.color}', padding: '12px 22px', borderRadius: 999, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>${c.text(action)}</a></section>`;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join('');
}

function teamCard(c: ElementContext): string {
  const [name = 'Name', role = '', bio = ''] = parts(c.label);
  return `${head('div', c, `display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 6, padding: 20, borderRadius: 14, backgroundColor: '${c.surface}', border: '1px solid ${c.line}'`)}<span style={{ width: 72, height: 72, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '${c.color}', color: '#ffffff', fontSize: 26, fontWeight: 700 }}>${c.text(initials(name))}</span><strong style={{ fontSize: 17, color: '${c.ink}' }}>${c.text(name)}</strong><span style={{ fontSize: 13, color: '${c.color}' }}>${c.text(role)}</span><span style={{ fontSize: 13, lineHeight: 1.5, color: '${c.muted}' }}>${c.text(bio)}</span></div>`;
}

function mediaTop(c: ElementContext, url: string | undefined, height: number): string {
  return isUrl(url)
    ? `<img src="${c.attr(url)}" alt="" style={{ width: '100%', height: ${height}, objectFit: 'cover', display: 'block' }} />`
    : `<div aria-hidden="true" style={{ height: ${height}, background: 'linear-gradient(135deg, ${c.color}55, ${c.color}22)' }} />`;
}

function blogCard(c: ElementContext): string {
  const [title = 'Post title', excerpt = '', date = '', image] = parts(c.label);
  return `${head('article', c, `display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden', backgroundColor: '${c.surface}', border: '1px solid ${c.line}'`)}${mediaTop(c, image, Math.round(c.height * 0.42))}<div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12, color: '${c.color}' }}>${c.text(date)}</span><strong style={{ fontSize: 17, color: '${c.ink}' }}>${c.text(title)}</strong><span style={{ fontSize: 14, lineHeight: 1.5, color: '${c.muted}' }}>${c.text(excerpt)}</span></div></article>`;
}

function productCard(c: ElementContext): string {
  const [name = 'Product', price = '', image] = parts(c.label);
  return `${head('div', c, `display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden', backgroundColor: '${c.surface}', border: '1px solid ${c.line}'`)}${mediaTop(c, image, Math.round(c.height * 0.5))}<div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}><strong style={{ fontSize: 16, color: '${c.ink}' }}>${c.text(name)}</strong><span style={{ fontSize: 18, fontWeight: 700, color: '${c.color}' }}>${c.text(price)}</span><VbAddToCart color="${c.color}" /></div></div>`;
}

// ---- data display ----------------------------------------------------------------

/** "Jan 12|Feb 19" -> [["Jan", 12], ["Feb", 19]]: the last number in each part is its value. */
function series(label: string): { readonly name: string; readonly value: number }[] {
  return parts(label).map((part) => {
    const match = /(-?\d+(?:\.\d+)?)\s*$/.exec(part);
    const value = match === null ? 0 : Number(match[1]);
    return { name: match === null ? part : part.slice(0, match.index).trim(), value };
  });
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

function barChart(c: ElementContext): string {
  const data = series(c.label);
  const max = Math.max(1, ...data.map((d) => d.value));
  const w = c.width;
  const h = c.height;
  const band = w / Math.max(1, data.length);
  const bars = data
    .map((d, i) => {
      const bh = ((h - 40) * d.value) / max;
      return `<rect x="${r1(i * band + band * 0.2)}" y="${r1(h - 24 - bh)}" width="${r1(band * 0.6)}" height="${r1(bh)}" rx="4" fill="${c.color}" /><text x="${r1(i * band + band / 2)}" y="${h - 6}" textAnchor="middle" fontSize="12" fill="${c.muted}">${c.text(d.name)}</text><text x="${r1(i * band + band / 2)}" y="${r1(h - 30 - bh)}" textAnchor="middle" fontSize="11" fill="${c.ink}">${d.value}</text>`;
    })
    .join('');
  return `<svg data-testid="${c.id}" role="img" aria-label="Bar chart" viewBox="0 0 ${w} ${h}" style={{ ${c.position} }}>${bars}</svg>`;
}

function lineChart(c: ElementContext): string {
  const data = series(c.label);
  const max = Math.max(1, ...data.map((d) => d.value));
  const min = Math.min(0, ...data.map((d) => d.value));
  const w = c.width;
  const h = c.height;
  const step = (w - 40) / Math.max(1, data.length - 1);
  const pts = data.map((d, i) => [20 + i * step, 12 + (h - 44) * (1 - (d.value - min) / (max - min || 1))] as const);
  const line = pts.map(([x, y]) => `${r1(x)},${r1(y)}`).join(' ');
  const area = `M${r1(pts[0]?.[0] ?? 20)},${h - 28} L${line.replace(/ /g, ' L')} L${r1(pts[pts.length - 1]?.[0] ?? 20)},${h - 28} Z`;
  const dots = pts.map(([x, y], i) => `<circle cx="${r1(x)}" cy="${r1(y)}" r="4" fill="${c.color}" /><text x="${r1(x)}" y="${h - 8}" textAnchor="middle" fontSize="12" fill="${c.muted}">${c.text(data[i]?.name ?? '')}</text>`).join('');
  return `<svg data-testid="${c.id}" role="img" aria-label="Line chart" viewBox="0 0 ${w} ${h}" style={{ ${c.position} }}><path d="${area}" fill="${c.color}" fillOpacity="0.12" /><polyline points="${line}" fill="none" stroke="${c.color}" strokeWidth="3" strokeLinejoin="round" />${dots}</svg>`;
}

const PIE_SHADES = [0, 0.25, 0.45, 0.6, 0.72, 0.82];

function pieChart(c: ElementContext): string {
  const data = series(c.label).filter((d) => d.value > 0);
  const total = data.reduce((sum, d) => sum + d.value, 0) || 1;
  const size = Math.min(c.height, c.width * 0.55);
  const cx = size / 2;
  const radius = size / 2 - 4;
  let angle = -Math.PI / 2;
  const slices = data
    .map((d, i) => {
      const sweep = (d.value / total) * Math.PI * 2;
      const [x1, y1] = [cx + radius * Math.cos(angle), cx + radius * Math.sin(angle)];
      angle += sweep;
      const [x2, y2] = [cx + radius * Math.cos(angle), cx + radius * Math.sin(angle)];
      const shade = PIE_SHADES[i % PIE_SHADES.length] ?? 0;
      const fill = mix(c.color, '#ffffff', shade);
      const path = data.length === 1 ? `M${r1(cx - radius)},${r1(cx)} a${r1(radius)},${r1(radius)} 0 1,0 ${r1(radius * 2)},0 a${r1(radius)},${r1(radius)} 0 1,0 ${r1(-radius * 2)},0` : `M${r1(cx)},${r1(cx)} L${r1(x1)},${r1(y1)} A${r1(radius)},${r1(radius)} 0 ${sweep > Math.PI ? 1 : 0},1 ${r1(x2)},${r1(y2)} Z`;
      return { path, fill, name: d.name, value: d.value };
    });
  const legend = slices.map((s) => `<div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '${c.ink}' }}><span style={{ width: 12, height: 12, borderRadius: 3, background: '${s.fill}' }} />${c.text(s.name)} <span style={{ color: '${c.muted}' }}>${Math.round((s.value / total) * 100)}%</span></div>`).join('');
  return `${head('div', c, `display: 'flex', alignItems: 'center', gap: 20`)}<svg role="img" aria-label="Pie chart" viewBox="0 0 ${r1(size)} ${r1(size)}" width="${r1(size)}" height="${r1(size)}">${slices.map((s) => `<path d="${s.path}" fill="${s.fill}" stroke="${c.surface}" strokeWidth="2" />`).join('')}</svg><div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>${legend}</div></div>`;
}

function descriptionList(c: ElementContext): string {
  const rows = parts(c.label)
    .map((part) => {
      const [key = '', ...rest] = part.split(':');
      return `<div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '10px 0', borderBottom: '1px solid ${c.line}' }}><dt style={{ fontSize: 14, color: '${c.muted}' }}>${c.text(key.trim())}</dt><dd style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '${c.ink}' }}>${c.text(rest.join(':').trim())}</dd></div>`;
    })
    .join('');
  return `${head('dl', c, `margin: 0, display: 'flex', flexDirection: 'column'`)}${rows}</dl>`;
}

function treeView(c: ElementContext): string {
  const rows = parts(c.label)
    .map((part) => {
      const depth = /^-*/.exec(part)?.[0].length ?? 0;
      const name = part.replace(/^-+/, '').trim();
      const folder = !/\.[a-z0-9]+$/i.test(name);
      return `<div style={{ paddingLeft: ${depth * 18}, display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '${c.ink}', fontFamily: 'ui-monospace, monospace' }}><span style={{ color: '${folder ? c.color : c.muted}' }}>${folder ? '▸ 📁' : '📄'}</span>${c.text(name)}</div>`;
    })
    .join('');
  return `${head('div', c, `display: 'flex', flexDirection: 'column', gap: 4, padding: 12, borderRadius: 10, backgroundColor: '${c.surface}', border: '1px solid ${c.line}'`, ' role="tree"')}${rows}</div>`;
}

function kanban(c: ElementContext): string {
  const columns = parts(c.label)
    .map((part) => {
      const [title = '', rest = ''] = part.split(':');
      const cards = rest.split(',').map((card) => card.trim()).filter(Boolean).map((card) => `<div style={{ padding: '10px 12px', borderRadius: 8, backgroundColor: '${c.surface}', border: '1px solid ${c.line}', fontSize: 14, color: '${c.ink}', boxShadow: '0 1px 2px rgba(0, 0, 0, 0.06)' }}>${c.text(card)}</div>`).join('');
      return `<div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderRadius: 12, backgroundColor: '${c.line}' }}><strong style={{ fontSize: 13, color: '${c.muted}', textTransform: 'uppercase' }}>${c.text(title.trim())}</strong>${cards}</div>`;
    })
    .join('');
  return `${head('div', c, `display: 'flex', gap: 12, alignItems: 'flex-start'`)}${columns}</div>`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function calendar(c: ElementContext): string {
  const [monthText = '2026-10', marked = ''] = parts(c.label);
  const match = /^(\d{4})-(\d{1,2})$/.exec(monthText);
  const year = match === null ? 2026 : Number(match[1]);
  const month = match === null ? 9 : Math.min(11, Math.max(0, Number(match[2]) - 1));
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const marks = new Set(marked.split(',').map((d) => Number(d.trim())).filter((d) => d > 0));
  const cells = [
    ...['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => `<span style={{ fontSize: 12, fontWeight: 600, color: '${c.muted}', textAlign: 'center' }}>${d}</span>`),
    ...Array.from({ length: first }, () => '<span />'),
    ...Array.from({ length: days }, (_u, i) => {
      const day = i + 1;
      const on = marks.has(day);
      return `<span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 32, borderRadius: 8, fontSize: 14, backgroundColor: '${on ? c.color : 'transparent'}', color: '${on ? '#ffffff' : c.ink}' }}>${day}</span>`;
    }),
  ].join('');
  return `${head('div', c, `display: 'flex', flexDirection: 'column', gap: 8, padding: 14, borderRadius: 12, backgroundColor: '${c.surface}', border: '1px solid ${c.line}'`)}<strong style={{ color: '${c.ink}' }}>${MONTHS[month]} ${year}</strong><div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>${cells}</div></div>`;
}

function timeline(c: ElementContext): string {
  const items = parts(c.label)
    .map((part) => {
      const [when = '', ...what] = part.split(' ');
      return `<li style={{ position: 'relative', paddingLeft: 24, paddingBottom: 14 }}><span style={{ position: 'absolute', left: -7, top: 3, width: 12, height: 12, borderRadius: '50%', backgroundColor: '${c.color}', border: '2px solid ${c.surface}' }} /><strong style={{ fontSize: 13, color: '${c.color}' }}>${c.text(when)}</strong><div style={{ fontSize: 14, color: '${c.ink}' }}>${c.text(what.join(' '))}</div></li>`;
    })
    .join('');
  return `${head('ol', c, `margin: 0, padding: 0, listStyle: 'none', borderLeft: '2px solid ${c.line}', marginLeft: 6`)}${items}</ol>`;
}

function stepper(c: ElementContext): string {
  const steps = parts(c.label);
  const current = Math.max(0, steps.findIndex((s) => s.startsWith('*')));
  const items = steps
    .map((step, i) => {
      const done = i < current;
      const active = i === current;
      const dot = `<span style={{ width: 30, height: 30, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, backgroundColor: '${done || active ? c.color : c.line}', color: '${done || active ? '#ffffff' : c.muted}' }}>${done ? '✓' : i + 1}</span>`;
      const bar = i < steps.length - 1 ? `<span style={{ flex: 1, height: 2, backgroundColor: '${done ? c.color : c.line}' }} />` : '';
      return `<div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: ${i < steps.length - 1 ? 1 : 0} }}>${dot}<span style={{ fontSize: 13, whiteSpace: 'nowrap', fontWeight: ${active ? 600 : 400}, color: '${active ? c.ink : c.muted}' }}>${c.text(step.replace(/^\*/, ''))}</span>${bar}</div>`;
    })
    .join('');
  return `${head('div', c, `display: 'flex', alignItems: 'center', gap: 8`)}${items}</div>`;
}

function kbd(c: ElementContext): string {
  const keys = c.label.split('+').map((key) => key.trim()).filter(Boolean).map((key) => `<kbd style={{ padding: '2px 8px', borderRadius: 6, border: '1px solid ${c.line}', borderBottomWidth: 3, backgroundColor: '${c.surface}', color: '${c.ink}', fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>${c.text(key)}</kbd>`).join('<span style={{ color: \'' + c.muted + '\' }}>+</span>');
  return `${head('span', c, `display: 'flex', alignItems: 'center', gap: 4`)}${keys}</span>`;
}

function skeleton(c: ElementContext): string {
  const bar = (width: string, height: number): string => `<span className="vb-skeleton" style={{ display: 'block', width: '${width}', height: ${height}, borderRadius: 6, backgroundColor: '${c.line}' }} />`;
  return `${head('div', c, `display: 'flex', flexDirection: 'column', gap: 10`, ' aria-busy="true"')}${bar('40%', 18)}${bar('100%', 12)}${bar('92%', 12)}${bar('70%', 12)}</div>`;
}

function emptyState(c: ElementContext): string {
  const [icon = '📭', title = 'Nothing here yet', text = '', action] = parts(c.label);
  const button = action === undefined ? '' : `<a href="#" style={{ marginTop: 8, backgroundColor: '${c.color}', color: '#ffffff', padding: '10px 18px', borderRadius: 8, textDecoration: 'none' }}>${c.text(action)}</a>`;
  return `${head('div', c, `display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 6`)}<span style={{ fontSize: 48 }}>${c.text(icon)}</span><strong style={{ fontSize: 20, color: '${c.ink}' }}>${c.text(title)}</strong><span style={{ fontSize: 14, color: '${c.muted}', maxWidth: 420 }}>${c.text(text)}</span>${button}</div>`;
}

function countdown(c: ElementContext): string {
  const [target = '2026-12-31T00:00', caption = ''] = parts(c.label);
  return `${head('div', c, `display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6`)}<span style={{ fontSize: 13, color: '${c.muted}' }}>${c.text(caption)}</span><VbCountdown target={${js(target)}} color="${c.color}" surface="${c.surface}" line="${c.line}" /></div>`;
}

function qrCode(c: ElementContext): string {
  const matrix = qrMatrix(c.label.trim() || 'https://example.com');
  const n = matrix.length;
  const cells: string[] = [];
  for (let y = 0; y < n; y += 1) {
    const row = matrix[y] ?? [];
    for (let x = 0; x < n; x += 1) if (row[x] === true) cells.push(`M${x + 4},${y + 4}h1v1h-1z`);
  }
  return `<svg data-testid="${c.id}" role="img" aria-label="QR code" viewBox="0 0 ${n + 8} ${n + 8}" shapeRendering="crispEdges" style={{ ${c.position}, backgroundColor: '#ffffff' }}><path d="${cells.join('')}" fill="#000000" /></svg>`;
}

export const CONTENT_RENDERERS: Readonly<Record<ContentType, (c: ElementContext) => string>> = {
  carousel, gallery, lightbox, 'before-after': beforeAfter, map, embed, 'custom-html': customHtml, audio, lottie,
  'social-icons': socialIcons, 'logo-cloud': logoCloud, 'feature-grid': featureGrid, 'faq-list': faqList, 'cta-banner': ctaBanner,
  'team-card': teamCard, 'blog-card': blogCard, 'product-card': productCard,
  'bar-chart': barChart, 'line-chart': lineChart, 'pie-chart': pieChart, 'description-list': descriptionList, 'tree-view': treeView,
  kanban, calendar, timeline, stepper, kbd, skeleton, 'empty-state': emptyState, countdown, 'qr-code': qrCode,
};

// ---- runtime --------------------------------------------------------------------

const HELPERS: Readonly<Record<string, readonly string[]>> = {
  carousel: [
    'function VbCarousel({ slides, color }: { readonly slides: readonly { readonly image: string; readonly text: string }[]; readonly color: string }) {',
    '  const [index, setIndex] = useState(0);',
    '  useEffect(() => {',
    '    const timer = setInterval(() => setIndex((i) => (i + 1) % Math.max(1, slides.length)), 4000);',
    '    return () => clearInterval(timer);',
    '  }, [slides.length]);',
    '  const go = (delta: number) => setIndex((i) => (i + delta + slides.length) % slides.length);',
    "  const arrow = { position: 'absolute', top: '50%', transform: 'translateY(-50%)', width: 36, height: 36, borderRadius: '50%', border: 'none', background: 'rgba(0, 0, 0, 0.45)', color: '#ffffff', cursor: 'pointer', fontSize: 18 } as const;",
    '  return (',
    "    <div style={{ position: 'relative', width: '100%', height: '100%' }}>",
    '      {slides.map((slide, i) => (',
    "        <div key={i} aria-hidden={i !== index} style={{ position: 'absolute', inset: 0, opacity: i === index ? 1 : 0, transition: 'opacity 600ms', display: 'flex', alignItems: 'center', justifyContent: 'center', background: slide.image !== '' ? `center / cover no-repeat url(${slide.image})` : `linear-gradient(135deg, ${color}, ${color}88)`, color: '#ffffff', fontSize: 28, fontWeight: 700 }}>{slide.text}</div>",
    '      ))}',
    "      <button type=\"button\" aria-label=\"Previous\" onClick={() => go(-1)} style={{ ...arrow, left: 12 }}>‹</button>",
    "      <button type=\"button\" aria-label=\"Next\" onClick={() => go(1)} style={{ ...arrow, right: 12 }}>›</button>",
    "      <div style={{ position: 'absolute', bottom: 12, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 6 }}>",
    "        {slides.map((_slide, i) => <button key={i} type=\"button\" aria-label={`Slide ${i + 1}`} onClick={() => setIndex(i)} style={{ width: 8, height: 8, borderRadius: '50%', border: 'none', padding: 0, cursor: 'pointer', background: i === index ? '#ffffff' : 'rgba(255, 255, 255, 0.5)' }} />)}",
    '      </div>',
    '    </div>',
    '  );',
    '}',
  ],
  gallery: [
    'function VbGallery({ images, color, line }: { readonly images: readonly string[]; readonly color: string; readonly line: string }) {',
    '  const [open, setOpen] = useState<number | null>(null);',
    '  const src = open === null ? \'\' : images[open] ?? \'\';',
    '  return (',
    "    <div style={{ flex: 1, display: 'grid', gridTemplateColumns: `repeat(${Math.min(4, Math.max(1, images.length))}, 1fr)`, gap: 8 }}>",
    '      {images.map((image, i) => (',
    "        <button key={i} type=\"button\" onClick={() => setOpen(i)} aria-label={`Open image ${i + 1}`} style={{ padding: 0, border: `1px solid ${line}`, borderRadius: 10, cursor: 'zoom-in', background: image !== '' ? `center / cover no-repeat url(${image})` : `linear-gradient(135deg, ${color}55, ${color}22)`, minHeight: 60 }} />",
    '      ))}',
    '      {open !== null && (',
    "        <div role=\"dialog\" aria-modal=\"true\" onClick={() => setOpen(null)} style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0, 0, 0, 0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}>",
    "          {src !== '' ? <img src={src} alt=\"\" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8 }} /> : <div style={{ width: 'min(640px, 90vw)', height: 400, borderRadius: 12, background: `linear-gradient(135deg, ${color}, ${color}88)` }} />}",
    '        </div>',
    '      )}',
    '    </div>',
    '  );',
    '}',
  ],
  'before-after': [
    'function VbCompare({ before, after, color }: { readonly before: string; readonly after: string; readonly color: string }) {',
    '  const [split, setSplit] = useState(50);',
    '  const fill = (image: string, fallback: string) => (image !== \'\' ? `center / cover no-repeat url(${image})` : fallback);',
    '  return (',
    "    <div style={{ position: 'relative', width: '100%', height: '100%' }}>",
    "      <div style={{ position: 'absolute', inset: 0, background: fill(after, `linear-gradient(135deg, ${color}, ${color}88)`) }} />",
    "      <div style={{ position: 'absolute', inset: 0, clipPath: `inset(0 ${100 - split}% 0 0)`, background: fill(before, '#9ca3af') }} />",
    "      <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${split}%`, width: 3, background: '#ffffff', boxShadow: '0 0 6px rgba(0, 0, 0, 0.4)' }} />",
    "      <input type=\"range\" min={0} max={100} value={split} aria-label=\"Compare before and after\" onChange={(event) => setSplit(Number(event.target.value))} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'ew-resize' }} />",
    '    </div>',
    '  );',
    '}',
  ],
  countdown: [
    'function VbCountdown({ target, color, surface, line }: { readonly target: string; readonly color: string; readonly surface: string; readonly line: string }) {',
    '  const [now, setNow] = useState(() => Date.now());',
    '  useEffect(() => {',
    '    const timer = setInterval(() => setNow(Date.now()), 1000);',
    '    return () => clearInterval(timer);',
    '  }, []);',
    '  const left = Math.max(0, new Date(target).getTime() - now);',
    "  const units: [string, number][] = [['Days', Math.floor(left / 86400000)], ['Hours', Math.floor(left / 3600000) % 24], ['Minutes', Math.floor(left / 60000) % 60], ['Seconds', Math.floor(left / 1000) % 60]];",
    '  return (',
    "    <div style={{ display: 'flex', gap: 10 }}>",
    '      {units.map(([name, value]) => (',
    "        <div key={name} style={{ minWidth: 64, padding: '8px 10px', borderRadius: 10, background: surface, border: `1px solid ${line}`, textAlign: 'center' }}>",
    "          <div style={{ fontSize: 28, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' }}>{String(value).padStart(2, '0')}</div>",
    "          <div style={{ fontSize: 11, textTransform: 'uppercase', opacity: 0.7 }}>{name}</div>",
    '        </div>',
    '      ))}',
    '    </div>',
    '  );',
    '}',
  ],
  'product-card': [
    'function VbAddToCart({ color }: { readonly color: string }) {',
    '  const [added, setAdded] = useState(false);',
    "  return <button type=\"button\" onClick={() => setAdded(!added)} style={{ marginTop: 'auto', border: 'none', borderRadius: 8, padding: '10px 0', cursor: 'pointer', color: '#ffffff', background: added ? '#16a34a' : color }}>{added ? 'Added ✓' : 'Add to cart'}</button>;",
    '}',
  ],
  lottie: [
    'function VbLottie({ src, muted }: { readonly src: string; readonly muted: string }) {',
    '  useEffect(() => {',
    "    if (src === '' || document.querySelector('script[data-vb-lottie]') !== null) return;",
    "    const script = document.createElement('script');",
    "    script.src = 'https://unpkg.com/@lottiefiles/lottie-player@2/dist/lottie-player.js';",
    "    script.dataset['vbLottie'] = 'true';",
    '    document.head.appendChild(script);',
    '  }, [src]);',
    "  if (src === '') return <span style={{ color: muted, fontSize: 13 }}>Lottie: paste a .json animation URL</span>;",
    "  return createElement('lottie-player', { src, background: 'transparent', speed: '1', loop: true, autoplay: true, style: { width: '100%', height: '100%' } });",
    '}',
  ],
};

const CSS: Readonly<Partial<Record<ContentType, readonly string[]>>> = {
  skeleton: ['@keyframes vb-skeleton { 50% { opacity: 0.45; } }', '.vb-skeleton { animation: vb-skeleton 1.4s ease-in-out infinite; }'],
};

export interface ContentRuntime {
  readonly values: readonly string[];
  readonly helpers: string;
  readonly css: readonly string[];
}

export function contentRuntime(types: ReadonlySet<string>): ContentRuntime {
  const used = CONTENT_TYPES.filter((type) => types.has(type));
  const helperKeys = [...new Set(used.map((type) => (type === 'lightbox' ? 'gallery' : type)))].filter((key) => key in HELPERS);
  const helpers = helperKeys.map((key) => (HELPERS[key] ?? []).join('\n'));
  const needsEffect = helperKeys.some((key) => ['carousel', 'countdown', 'lottie'].includes(key));
  return {
    values: [
      ...(helpers.length > 0 ? ['useState'] : []),
      ...(needsEffect ? ['useEffect'] : []),
      ...(helperKeys.includes('lottie') ? ['createElement'] : []),
    ],
    helpers: helpers.join('\n\n'),
    css: used.flatMap((type) => CSS[type] ?? []),
  };
}
