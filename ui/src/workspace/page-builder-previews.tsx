/**
 * Editor previews for the extended elements (page-builder-catalogue.ts).
 *
 * Same honest tradeoff PageBuilderCanvas documents for the basic set: these
 * are styled, non-interactive stand-ins that look like what
 * src/generate/canvas-elements.ts generates, not the generated markup itself -
 * the whole node is also the drag surface, and a live <input>, <video> or
 * <details> would fight the drag gesture.
 */
import type { CSSProperties, ReactNode } from 'react';
import { labelParts } from './page-builder-catalogue';
import type { CanvasElement, ExtendedElementType } from './page-builder-types';

export interface PreviewVisual {
  readonly style: CSSProperties;
  readonly content: ReactNode;
}

type Preview = (element: CanvasElement, color: string) => PreviewVisual;

const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#e2e8f0';
const flexCenter: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center' };
const surface: CSSProperties = { background: '#ffffff', border: `1px solid ${LINE}`, borderRadius: 12, overflow: 'hidden' };

function numberIn(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) && value !== undefined && value !== '' ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function fieldPreview(type: string): Preview {
  return (element, color) => ({
    style: { border: `1px solid ${color}`, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', color: MUTED },
    content: (
      <>
        <span>{element.label}</span>
        <span style={{ fontSize: 10, color }}>{type}</span>
      </>
    ),
  });
}

const PREVIEWS: Readonly<Record<ExtendedElementType, Preview>> = {
  section: (_element, color) => ({ style: { backgroundColor: `${color}14`, borderRadius: 12, padding: 8, color }, content: 'Section' }),
  card: (element, color) => {
    const [title, body, action] = labelParts(element.label);
    return {
      style: { ...surface, boxShadow: '0 4px 14px rgba(15,23,42,0.08)', padding: 16, display: 'flex', flexDirection: 'column', gap: 6 },
      content: (
        <>
          <strong style={{ fontSize: 16, color: INK }}>{title}</strong>
          <span style={{ color: '#475569', flex: 1 }}>{body}</span>
          {action !== undefined && <span style={{ alignSelf: 'flex-start', background: color, color: '#fff', borderRadius: 8, padding: '6px 12px' }}>{action}</span>}
        </>
      ),
    };
  },
  navbar: (element, color) => {
    const [brand, ...links] = labelParts(element.label);
    return {
      style: { background: color, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px' },
      content: (
        <>
          <strong style={{ fontSize: 16 }}>{brand}</strong>
          <span style={{ display: 'flex', gap: 20 }}>{links.map((link, index) => <span key={index}>{link}</span>)}</span>
        </>
      ),
    };
  },
  hero: (element, color) => {
    const [title, subtitle, action] = labelParts(element.label);
    return {
      style: { ...flexCenter, flexDirection: 'column', gap: 12, borderRadius: 16, padding: 24, textAlign: 'center', color: '#fff', background: `linear-gradient(135deg, ${color}, ${color}bb)` },
      content: (
        <>
          <strong style={{ fontSize: 34, lineHeight: 1.1 }}>{title}</strong>
          <span style={{ fontSize: 16, opacity: 0.9 }}>{subtitle}</span>
          {action !== undefined && <span style={{ background: '#fff', color, borderRadius: 999, padding: '10px 24px', fontWeight: 600 }}>{action}</span>}
        </>
      ),
    };
  },
  footer: (element, color) => {
    const [note, ...links] = labelParts(element.label);
    return {
      style: { background: INK, color: '#cbd5e1', borderTop: `3px solid ${color}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px' },
      content: (
        <>
          <span>{note}</span>
          <span style={{ display: 'flex', gap: 16 }}>{links.map((link, index) => <span key={index}>{link}</span>)}</span>
        </>
      ),
    };
  },
  paragraph: (element, color) => ({ style: { color, fontSize: 14, lineHeight: 1.6, overflow: 'hidden' }, content: element.label }),
  quote: (element, color) => {
    const [text, author] = labelParts(element.label);
    return {
      style: { borderLeft: `4px solid ${color}`, paddingLeft: 14, fontStyle: 'italic', fontSize: 16, color: '#334155' },
      content: (
        <>
          {text}
          {author !== undefined && <div style={{ fontStyle: 'normal', fontSize: 12, color: MUTED, marginTop: 6 }}>— {author}</div>}
        </>
      ),
    };
  },
  code: (element, color) => ({
    style: { background: INK, color: '#e2e8f0', borderTop: `3px solid ${color}`, borderRadius: 8, padding: 10, fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre', overflow: 'hidden' },
    content: labelParts(element.label).join('\n'),
  }),
  list: (element, color) => ({
    style: { color, paddingLeft: 4, lineHeight: 1.8 },
    content: labelParts(element.label).map((item, index) => <div key={index}>• {item}</div>),
  }),
  badge: (element, color) => ({ style: { ...flexCenter, background: `${color}1f`, color, borderRadius: 999, fontSize: 11, fontWeight: 600 }, content: element.label }),
  video: (element, color) => ({
    style: { ...flexCenter, gap: 8, background: INK, color: '#fff', borderRadius: 8, border: `2px solid ${color}` },
    content: (
      <>
        <span style={{ fontSize: 26, color }}>▶</span>
        <span style={{ maxWidth: '70%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{element.label}</span>
      </>
    ),
  }),
  icon: (element, color) => ({
    style: { ...flexCenter, borderRadius: '50%', background: `${color}1f`, color, fontSize: Math.max(12, Math.min(element.width, element.height) * 0.5) },
    content: element.label,
  }),
  avatar: (element, color) => ({
    style: { ...flexCenter, borderRadius: '50%', background: color, color: '#fff', fontWeight: 600, fontSize: Math.max(10, Math.min(element.width, element.height) * 0.4) },
    content: element.label.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join(''),
  }),
  email: fieldPreview('email'),
  password: fieldPreview('password'),
  number: fieldPreview('number'),
  date: fieldPreview('date'),
  search: fieldPreview('search'),
  toggle: (element, color) => ({
    style: { display: 'flex', alignItems: 'center', gap: 10, color: INK },
    content: (
      <>
        <span style={{ width: 34, height: 18, borderRadius: 999, background: color, position: 'relative', flexShrink: 0 }}>
          <span style={{ position: 'absolute', right: 2, top: 2, width: 14, height: 14, borderRadius: '50%', background: '#fff' }} />
        </span>
        {element.label}
      </>
    ),
  }),
  slider: (_element, color) => ({
    style: { display: 'flex', alignItems: 'center' },
    content: (
      <span style={{ position: 'relative', width: '100%', height: 4, borderRadius: 999, background: LINE }}>
        <span style={{ position: 'absolute', left: 0, top: 0, width: '50%', height: 4, borderRadius: 999, background: color }} />
        <span style={{ position: 'absolute', left: 'calc(50% - 7px)', top: -5, width: 14, height: 14, borderRadius: '50%', background: color }} />
      </span>
    ),
  }),
  file: (element, color) => ({ style: { ...flexCenter, border: `2px dashed ${color}`, borderRadius: 10, color, textAlign: 'center', padding: 8 }, content: element.label }),
  rating: (element, color) => {
    const [score, caption] = labelParts(element.label);
    const filled = numberIn(score, 4, 0, 5);
    return {
      style: { display: 'flex', alignItems: 'center', color, fontSize: 18, letterSpacing: 2 },
      content: (
        <>
          {'★'.repeat(filled) + '☆'.repeat(5 - filled)}
          {caption !== undefined && <span style={{ marginLeft: 8, fontSize: 12, letterSpacing: 0, color: MUTED }}>{caption}</span>}
        </>
      ),
    };
  },
  table: (element, color) => {
    const [header = [], ...rows] = labelParts(element.label).map((row) => row.split(',').map((cell) => cell.trim()));
    const cell: CSSProperties = { padding: '6px 10px', textAlign: 'left' };
    return {
      style: { ...surface, borderRadius: 8 },
      content: (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>{header.map((text, index) => <th key={index} style={{ ...cell, background: color, color: '#fff' }}>{text}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>{row.map((text, index) => <td key={index} style={{ ...cell, borderBottom: `1px solid ${LINE}`, color: '#334155' }}>{text}</td>)}</tr>
            ))}
          </tbody>
        </table>
      ),
    };
  },
  stat: (element, color) => {
    const [value, caption] = labelParts(element.label);
    return {
      style: { ...surface, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 14 },
      content: (
        <>
          <strong style={{ fontSize: 26, color }}>{value}</strong>
          <span style={{ color: MUTED }}>{caption}</span>
        </>
      ),
    };
  },
  progress: (element, color) => {
    const [value, caption = ''] = labelParts(element.label);
    const percent = numberIn(value, 50, 0, 100);
    return {
      style: { display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6, color: INK, fontSize: 12 },
      content: (
        <>
          <span>{caption} {percent}%</span>
          <span style={{ height: 8, borderRadius: 999, background: LINE, overflow: 'hidden' }}>
            <span style={{ display: 'block', width: `${percent}%`, height: '100%', background: color }} />
          </span>
        </>
      ),
    };
  },
  pricing: (element, color) => {
    const [plan, price, ...features] = labelParts(element.label);
    return {
      style: { ...surface, border: `2px solid ${color}`, borderRadius: 16, padding: 18, display: 'flex', flexDirection: 'column', gap: 8 },
      content: (
        <>
          <span style={{ color, fontWeight: 600, textTransform: 'uppercase', fontSize: 12 }}>{plan}</span>
          <strong style={{ fontSize: 28, color: INK }}>{price}</strong>
          <span style={{ flex: 1, lineHeight: 1.8, color: '#334155' }}>{features.map((feature, index) => <div key={index}>✓ {feature}</div>)}</span>
          <span style={{ ...flexCenter, background: color, color: '#fff', borderRadius: 8, padding: '8px 0' }}>Get started</span>
        </>
      ),
    };
  },
  testimonial: (element, color) => {
    const [text, author, role] = labelParts(element.label);
    return {
      style: { ...surface, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 },
      content: (
        <>
          <span style={{ fontSize: 14, lineHeight: 1.5, color: '#334155' }}>“{text}”</span>
          <span><strong style={{ color }}>{author}</strong> <span style={{ color: MUTED }}>{role}</span></span>
        </>
      ),
    };
  },
  tabs: (element, color) => ({
    style: { display: 'flex', alignItems: 'flex-end', gap: 18, borderBottom: `1px solid ${LINE}` },
    content: labelParts(element.label).map((tab, index) => (
      <span key={index} style={{ padding: '6px 2px', color: index === 0 ? color : MUTED, fontWeight: index === 0 ? 600 : 400, borderBottom: `2px solid ${index === 0 ? color : 'transparent'}` }}>
        {tab}
      </span>
    )),
  }),
  breadcrumb: (element, color) => {
    const crumbs = labelParts(element.label);
    return {
      style: { display: 'flex', alignItems: 'center', gap: 6 },
      content: crumbs.map((crumb, index) =>
        index === crumbs.length - 1 ? (
          <strong key={index} style={{ color: INK }}>{crumb}</strong>
        ) : (
          <span key={index} style={{ color }}>{crumb} <span style={{ color: MUTED }}>/</span></span>
        ),
      ),
    };
  },
  pagination: (element, color) => {
    const pages = numberIn(element.label, 3, 1, 9);
    const box = (text: string, active: boolean, key: string): JSX.Element => (
      <span key={key} style={{ ...flexCenter, minWidth: 28, height: 28, borderRadius: 8, border: `1px solid ${active ? color : LINE}`, background: active ? color : '#fff', color: active ? '#fff' : INK }}>
        {text}
      </span>
    );
    return {
      style: { display: 'flex', alignItems: 'center', gap: 5 },
      content: [box('‹', false, 'prev'), ...Array.from({ length: pages }, (_unused, index) => box(String(index + 1), index === 0, String(index))), box('›', false, 'next')],
    };
  },
  alert: (element, color) => ({ style: { display: 'flex', alignItems: 'center', padding: '0 14px', background: `${color}14`, borderLeft: `4px solid ${color}`, borderRadius: 8, color }, content: element.label }),
  accordion: (element, color) => {
    const [title, body] = labelParts(element.label);
    return {
      style: { ...surface, borderRadius: 10, padding: '10px 14px' },
      content: (
        <>
          <strong style={{ color }}>▾ {title}</strong>
          <div style={{ marginTop: 6, color: '#475569', lineHeight: 1.5 }}>{body}</div>
        </>
      ),
    };
  },
  spinner: (element, color) => ({
    style: { ...flexCenter },
    content: (
      <span
        style={{
          width: Math.min(element.width, element.height),
          height: Math.min(element.width, element.height),
          boxSizing: 'border-box',
          borderRadius: '50%',
          border: `4px solid ${color}33`,
          borderTopColor: color,
          animation: 'vb-spin 0.8s linear infinite',
        }}
      />
    ),
  }),
};

export const SPIN_KEYFRAMES = '@keyframes vb-spin { to { transform: rotate(360deg); } }';

export function extendedPreview(type: ExtendedElementType, element: CanvasElement, color: string): PreviewVisual {
  return PREVIEWS[type](element, color);
}
