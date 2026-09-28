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
import { parseBackgroundLabel, renderBackgroundSvg, type BackgroundKind } from './svg-backgrounds';
import type { CanvasElement, ExtendedElementType } from './page-builder-types';

export interface PreviewVisual {
  readonly style: CSSProperties;
  readonly content: ReactNode;
  /** A class for the element's root - an animation that must run on the root itself. */
  readonly className?: string;
}

/** The theme colours a preview is drawn with (page-theme.ts). */
export interface PreviewPalette {
  readonly ink: string;
  readonly muted: string;
  readonly line: string;
  readonly surface: string;
  /** The page background, which layered backgrounds blend into. */
  readonly background: string;
}

/** The same SVG the generated page gets (svg-backgrounds.ts), drawn with HTML attribute names. */
function backgroundPreview(kind: BackgroundKind): Preview {
  return (element, color, p) => {
    const { seed, complexity } = parseBackgroundLabel(element.label);
    const svg = renderBackgroundSvg(kind, { id: `preview-${element.id}`, width: element.width, height: element.height, color, background: p.background, seed, complexity }, 'html');
    return { style: { overflow: 'hidden' }, content: <div style={{ width: '100%', height: '100%' }} dangerouslySetInnerHTML={{ __html: svg }} /> };
  };
}

type Preview = (element: CanvasElement, color: string, p: PreviewPalette) => PreviewVisual;
const flexCenter: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center' };
const surface = (p: PreviewPalette): CSSProperties => ({ background: p.surface, border: `1px solid ${p.line}`, borderRadius: 12, overflow: 'hidden' });

function numberIn(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) && value !== undefined && value !== '' ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function fieldPreview(type: string): Preview {
  return (element, color, p) => ({
    style: { border: `1px solid ${color}`, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', color: p.muted },
    content: (
      <>
        <span>{element.label}</span>
        <span style={{ fontSize: 10, color }}>{type}</span>
      </>
    ),
  });
}

const textSize = (element: CanvasElement): number => Math.max(14, Math.min(64, Math.round(element.height * 0.55)));

const pill = (color: string): CSSProperties => ({ ...flexCenter, backgroundColor: color, color: '#fff', borderRadius: 8, padding: '0 14px' });

function choicePreview(kind: 'radio' | 'checkbox'): Preview {
  return (element, color, p) => {
    const [legend, ...options] = labelParts(element.label);
    return {
      style: { border: `1px solid ${p.line}`, borderRadius: 10, padding: '6px 12px', display: 'flex', flexDirection: 'column', gap: 4, color: p.ink },
      content: (
        <>
          <span style={{ fontSize: 12, fontWeight: 600, color: p.muted }}>{legend}</span>
          {options.map((option, i) => (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 12, height: 12, border: `2px solid ${color}`, borderRadius: kind === 'radio' ? '50%' : 3, background: i === 0 ? color : 'transparent' }} />
              {option}
            </span>
          ))}
        </>
      ),
    };
  };
}

const field = (p: PreviewPalette): CSSProperties => ({ border: `1px solid ${p.line}`, borderRadius: 8, background: p.surface, color: p.muted, display: 'flex', alignItems: 'center', padding: '0 10px' });

const PREVIEWS: Readonly<Record<ExtendedElementType, Preview>> = {
  'radio-group': choicePreview('radio'),
  'checkbox-group': choicePreview('checkbox'),
  segmented: (element, color, p) => ({
    style: { display: 'flex', gap: 4, padding: 4, borderRadius: 10, background: p.line },
    content: labelParts(element.label).map((option, i) => (
      <span key={i} style={{ flex: 1, ...flexCenter, borderRadius: 8, background: i === 0 ? color : 'transparent', color: i === 0 ? '#fff' : p.ink }}>{option}</span>
    )),
  }),
  time: (element, _color, p) => ({ style: field(p), content: `🕒 ${element.label}` }),
  'date-range': (element, _color, p) => {
    const [from = 'From', to = 'To'] = labelParts(element.label);
    return { style: { display: 'flex', gap: 10, alignItems: 'flex-end' }, content: [from, to].map((label) => <span key={label} style={{ flex: 1, height: 40, ...field(p) }}>📅 {label}</span>) };
  },
  'color-input': (element, color, p) => ({ style: { display: 'flex', alignItems: 'center', gap: 8, color: p.ink }, content: (<><span style={{ width: 36, height: 28, borderRadius: 6, background: color }} />{element.label}</>) }),
  phone: (element, _color, p) => ({ style: field(p), content: `☎ ${element.label}` }),
  url: (element, _color, p) => ({ style: field(p), content: `🔗 ${element.label}` }),
  'multi-select': (element, color, p) => {
    const [, ...options] = labelParts(element.label);
    return { style: { ...field(p), flexDirection: 'column', alignItems: 'stretch', padding: 4, gap: 2 }, content: options.map((option, i) => <span key={i} style={{ padding: '2px 6px', borderRadius: 4, background: i === 0 ? `${color}33` : 'transparent', color: p.ink }}>{option}</span>) };
  },
  'tag-input': (element, color, p) => ({ style: { ...field(p), gap: 6 }, content: (<><span style={{ padding: '1px 8px', borderRadius: 999, background: color, color: '#fff' }}>design ×</span>{element.label}</>) }),
  otp: (_element, _color, p) => ({ style: { ...field(p), justifyContent: 'center', fontFamily: 'ui-monospace, monospace', fontSize: 22, letterSpacing: '0.5em' }, content: '000000' }),
  newsletter: (element, color, p) => {
    const [title, placeholder, action = 'Subscribe'] = labelParts(element.label);
    return {
      style: { display: 'flex', flexDirection: 'column', gap: 8, justifyContent: 'center' },
      content: (
        <>
          <strong style={{ color: p.ink, fontSize: 16 }}>{title}</strong>
          <span style={{ display: 'flex', gap: 6 }}>
            <span style={{ flex: 1, height: 38, ...field(p) }}>{placeholder}</span>
            <span style={{ ...flexCenter, background: color, color: '#fff', borderRadius: 8, padding: '0 14px' }}>{action}</span>
          </span>
        </>
      ),
    };
  },
  signature: (element, color, p) => ({ style: { border: `1px dashed ${p.line}`, borderRadius: 10, background: p.surface, ...flexCenter, flexDirection: 'column', color: p.muted }, content: (<><span style={{ fontFamily: 'cursive', fontSize: 28, color }}>~ Ada L. ~</span>{element.label}</>) }),
  'rich-text': (element, _color, p) => ({
    style: { border: `1px solid ${p.line}`, borderRadius: 10, background: p.surface, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
    content: (
      <>
        <span style={{ borderBottom: `1px solid ${p.line}`, padding: '4px 8px', color: p.ink, fontSize: 12 }}><b>B</b> <i>I</i> • List</span>
        <span style={{ padding: 10, color: p.muted }}>{element.label}</span>
      </>
    ),
  }),
  columns: (element, _color, p) => ({
    style: { display: 'flex', gap: 16 },
    content: (labelParts(element.label).length > 0 ? labelParts(element.label) : ['Column 1', 'Column 2', 'Column 3']).map((title, i) => (
      <div key={i} style={{ flex: 1, border: `1px dashed ${p.line}`, borderRadius: 10, padding: 12, color: p.muted }}>{title}</div>
    )),
  }),
  spacer: (_element, _color, p) => ({ style: { border: `1px dashed ${p.line}`, borderRadius: 4, ...flexCenter, color: p.muted, fontSize: 11 }, content: 'spacer' }),
  sidebar: (element, color, p) => {
    const [brand, ...items] = labelParts(element.label);
    return {
      style: { background: p.surface, borderRight: `1px solid ${p.line}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 4 },
      content: (
        <>
          <strong style={{ color: p.ink, padding: '4px 10px 12px', fontSize: 16 }}>{brand}</strong>
          {items.map((item, i) => (
            <span key={i} style={{ padding: '8px 10px', borderRadius: 8, background: i === 0 ? color : 'transparent', color: i === 0 ? '#fff' : p.ink }}>{item}</span>
          ))}
        </>
      ),
    };
  },
  'mobile-menu': (element, color, p) => ({
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px', background: p.surface, borderBottom: `1px solid ${p.line}` },
    content: (
      <>
        <strong style={{ color: p.ink }}>{labelParts(element.label)[0]}</strong>
        <span style={{ fontSize: 22, color }}>☰</span>
      </>
    ),
  }),
  modal: (element, color, _p) => ({ style: { display: 'flex', alignItems: 'center' }, content: <span style={{ ...pill(color), height: '100%' }}>{labelParts(element.label)[0] ?? 'Open'} ⧉</span> }),
  tooltip: (element, color, _p) => ({
    style: { display: 'flex', alignItems: 'center', color, textDecoration: 'underline dotted' },
    content: <span title={labelParts(element.label)[1]}>{labelParts(element.label)[0]} ⓘ</span>,
  }),
  'dropdown-menu': (element, color, _p) => ({ style: { display: 'flex', alignItems: 'center' }, content: <span style={{ ...pill(color), height: '100%' }}>{labelParts(element.label)[0] ?? 'Menu'} ▾</span> }),
  toast: (element, color, p) => ({
    style: { display: 'flex', alignItems: 'center', padding: '0 16px', borderRadius: 10, background: p.surface, color: p.ink, borderLeft: `4px solid ${color}`, boxShadow: '0 8px 24px rgba(0,0,0,0.18)' },
    content: element.label,
  }),
  'back-to-top': (element, color, _p) => ({ style: { ...flexCenter, borderRadius: '50%', background: color, color: '#fff', fontSize: 18 }, content: element.label || '↑' }),
  'scroll-progress': (_element, color, p) => ({ style: { background: p.line }, content: <span style={{ display: 'block', width: '40%', height: '100%', background: color }} /> }),
  fab: (element, color, _p) => ({ style: { ...flexCenter, borderRadius: '50%', background: color, color: '#fff', fontSize: 24, boxShadow: '0 8px 20px rgba(0,0,0,0.25)' }, content: element.label || '+' }),
  'cookie-banner': (element, color, p) => {
    const [text, accept = 'Accept'] = labelParts(element.label);
    return {
      style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', borderRadius: 12, background: p.surface, color: p.ink, boxShadow: '0 8px 30px rgba(0,0,0,0.2)' },
      content: (
        <>
          <span>{text}</span>
          <span style={{ ...pill(color), height: 32 }}>{accept}</span>
        </>
      ),
    };
  },
  typewriter: (element, color, _p) => ({
    style: { display: 'flex', alignItems: 'center', color, fontSize: textSize(element), fontWeight: 700 },
    content: (
      <>
        {element.label}
        <span className="vb-caret">|</span>
      </>
    ),
  }),
  'text-shimmer': (element, color, _p) => ({
    style: { display: 'flex', alignItems: 'center', fontSize: textSize(element), fontWeight: 700 },
    content: <span className="vb-shimmer" style={{ backgroundImage: `linear-gradient(90deg, ${color} 0%, ${color} 35%, #ffffff 50%, ${color} 65%, ${color} 100%)` }}>{element.label}</span>,
  }),
  'text-scramble': (element, color, _p) => ({
    style: { display: 'flex', alignItems: 'center', color, fontSize: textSize(element), fontWeight: 700, fontFamily: 'ui-monospace, monospace' },
    content: element.label,
  }),
  'word-reveal': (element, color, _p) => ({
    style: { display: 'flex', flexWrap: 'wrap', alignContent: 'center', gap: '0 0.3em', color, fontSize: textSize(element), fontWeight: 700 },
    content: element.label.split(/\s+/).filter(Boolean).map((word, i) => (
      <span key={i} className="vb-word" style={{ animationDelay: `${i * 90}ms` }}>{word}</span>
    )),
  }),
  counter: (element, color, p) => {
    const [value = '0', suffix = '', caption = ''] = labelParts(element.label);
    return {
      style: { display: 'flex', flexDirection: 'column', justifyContent: 'center' },
      content: (
        <>
          <strong style={{ fontSize: Math.max(20, Math.min(64, Math.round(element.height * 0.45))), color, lineHeight: 1.1 }}>
            {Number(value.replace(/[^0-9.]/g, '') || 0).toLocaleString()}
            {suffix}
          </strong>
          <span style={{ fontSize: 14, color: p.muted }}>{caption}</span>
        </>
      ),
    };
  },
  marquee: (element, color, _p) => {
    const items = labelParts(element.label).map((item, i) => <span key={i} style={{ fontSize: 20, fontWeight: 600, color, whiteSpace: 'nowrap' }}>{item}</span>);
    return { style: { overflow: 'hidden', display: 'flex', alignItems: 'center' }, content: <div className="vb-marquee">{items}{items}</div> };
  },
  'gradient-border': (element, color, p) => {
    const [title = 'Featured', body = ''] = labelParts(element.label);
    return {
      style: {
        border: '2px solid transparent',
        borderRadius: 16,
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: `linear-gradient(${p.surface}, ${p.surface}) padding-box, linear-gradient(120deg, ${color}, #ffffff, ${color}, #ffffff, ${color}) border-box`,
        backgroundSize: '100% 100%, 300% 300%',
      },
      className: 'vb-gradient-border',
      content: (
        <>
          <strong style={{ fontSize: 18, color: p.ink }}>{title}</strong>
          <span style={{ fontSize: 13, color: p.muted }}>{body}</span>
        </>
      ),
    };
  },
  waves: backgroundPreview('waves'),
  'layered-waves': backgroundPreview('layered-waves'),
  blob: backgroundPreview('blob'),
  'blob-scene': backgroundPreview('blob-scene'),
  peaks: backgroundPreview('peaks'),
  circles: backgroundPreview('circles'),
  'mesh-gradient': backgroundPreview('mesh-gradient'),
  section: (_element, color, _p) => ({ style: { backgroundColor: `${color}14`, borderRadius: 12, padding: 8, color }, content: 'Section' }),
  card: (element, color, p) => {
    const [title, body, action] = labelParts(element.label);
    return {
      style: { ...surface(p), boxShadow: '0 4px 14px rgba(15,23,42,0.08)', padding: 16, display: 'flex', flexDirection: 'column', gap: 6 },
      content: (
        <>
          <strong style={{ fontSize: 16, color: p.ink }}>{title}</strong>
          <span style={{ color: p.muted, flex: 1 }}>{body}</span>
          {action !== undefined && <span style={{ alignSelf: 'flex-start', background: color, color: '#fff', borderRadius: 8, padding: '6px 12px' }}>{action}</span>}
        </>
      ),
    };
  },
  navbar: (element, color, _p) => {
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
  hero: (element, color, p) => {
    const [title, subtitle, action] = labelParts(element.label);
    return {
      style: { ...flexCenter, flexDirection: 'column', gap: 12, borderRadius: 16, padding: 24, textAlign: 'center', color: '#fff', background: `linear-gradient(135deg, ${color}, ${color}bb)` },
      content: (
        <>
          <strong style={{ fontSize: 34, lineHeight: 1.1 }}>{title}</strong>
          <span style={{ fontSize: 16, opacity: 0.9 }}>{subtitle}</span>
          {action !== undefined && <span style={{ background: p.surface, color, borderRadius: 999, padding: '10px 24px', fontWeight: 600 }}>{action}</span>}
        </>
      ),
    };
  },
  footer: (element, color, _p) => {
    const [note, ...links] = labelParts(element.label);
    return {
      style: { background: '#0f172a', color: '#cbd5e1', borderTop: `3px solid ${color}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px' },
      content: (
        <>
          <span>{note}</span>
          <span style={{ display: 'flex', gap: 16 }}>{links.map((link, index) => <span key={index}>{link}</span>)}</span>
        </>
      ),
    };
  },
  paragraph: (element, color, _p) => ({ style: { color, fontSize: 14, lineHeight: 1.6, overflow: 'hidden' }, content: element.label }),
  quote: (element, color, p) => {
    const [text, author] = labelParts(element.label);
    return {
      style: { borderLeft: `4px solid ${color}`, paddingLeft: 14, fontStyle: 'italic', fontSize: 16, color: p.ink },
      content: (
        <>
          {text}
          {author !== undefined && <div style={{ fontStyle: 'normal', fontSize: 12, color: p.muted, marginTop: 6 }}>— {author}</div>}
        </>
      ),
    };
  },
  code: (element, color, _p) => ({
    style: { background: '#0f172a', color: '#e2e8f0', borderTop: `3px solid ${color}`, borderRadius: 8, padding: 10, fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre', overflow: 'hidden' },
    content: labelParts(element.label).join('\n'),
  }),
  list: (element, color, _p) => ({
    style: { color, paddingLeft: 4, lineHeight: 1.8 },
    content: labelParts(element.label).map((item, index) => <div key={index}>• {item}</div>),
  }),
  badge: (element, color, _p) => ({ style: { ...flexCenter, background: `${color}1f`, color, borderRadius: 999, fontSize: 11, fontWeight: 600 }, content: element.label }),
  video: (element, color, _p) => ({
    style: { ...flexCenter, gap: 8, background: '#0f172a', color: '#fff', borderRadius: 8, border: `2px solid ${color}` },
    content: (
      <>
        <span style={{ fontSize: 26, color }}>▶</span>
        <span style={{ maxWidth: '70%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{element.label}</span>
      </>
    ),
  }),
  icon: (element, color, _p) => ({
    style: { ...flexCenter, borderRadius: '50%', background: `${color}1f`, color, fontSize: Math.max(12, Math.min(element.width, element.height) * 0.5) },
    content: element.label,
  }),
  avatar: (element, color, _p) => ({
    style: { ...flexCenter, borderRadius: '50%', background: color, color: '#fff', fontWeight: 600, fontSize: Math.max(10, Math.min(element.width, element.height) * 0.4) },
    content: element.label.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join(''),
  }),
  email: fieldPreview('email'),
  password: fieldPreview('password'),
  number: fieldPreview('number'),
  date: fieldPreview('date'),
  search: fieldPreview('search'),
  toggle: (element, color, p) => ({
    style: { display: 'flex', alignItems: 'center', gap: 10, color: p.ink },
    content: (
      <>
        <span style={{ width: 34, height: 18, borderRadius: 999, background: color, position: 'relative', flexShrink: 0 }}>
          <span style={{ position: 'absolute', right: 2, top: 2, width: 14, height: 14, borderRadius: '50%', background: p.surface }} />
        </span>
        {element.label}
      </>
    ),
  }),
  slider: (_element, color, p) => ({
    style: { display: 'flex', alignItems: 'center' },
    content: (
      <span style={{ position: 'relative', width: '100%', height: 4, borderRadius: 999, background: p.line }}>
        <span style={{ position: 'absolute', left: 0, top: 0, width: '50%', height: 4, borderRadius: 999, background: color }} />
        <span style={{ position: 'absolute', left: 'calc(50% - 7px)', top: -5, width: 14, height: 14, borderRadius: '50%', background: color }} />
      </span>
    ),
  }),
  file: (element, color, _p) => ({ style: { ...flexCenter, border: `2px dashed ${color}`, borderRadius: 10, color, textAlign: 'center', padding: 8 }, content: element.label }),
  rating: (element, color, p) => {
    const [score, caption] = labelParts(element.label);
    const filled = numberIn(score, 4, 0, 5);
    return {
      style: { display: 'flex', alignItems: 'center', color, fontSize: 18, letterSpacing: 2 },
      content: (
        <>
          {'★'.repeat(filled) + '☆'.repeat(5 - filled)}
          {caption !== undefined && <span style={{ marginLeft: 8, fontSize: 12, letterSpacing: 0, color: p.muted }}>{caption}</span>}
        </>
      ),
    };
  },
  table: (element, color, p) => {
    const [header = [], ...rows] = labelParts(element.label).map((row) => row.split(',').map((cell) => cell.trim()));
    const cell: CSSProperties = { padding: '6px 10px', textAlign: 'left' };
    return {
      style: { ...surface(p), borderRadius: 8 },
      content: (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>{header.map((text, index) => <th key={index} style={{ ...cell, background: color, color: '#fff' }}>{text}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>{row.map((text, index) => <td key={index} style={{ ...cell, borderBottom: `1px solid ${p.line}`, color: p.ink }}>{text}</td>)}</tr>
            ))}
          </tbody>
        </table>
      ),
    };
  },
  stat: (element, color, p) => {
    const [value, caption] = labelParts(element.label);
    return {
      style: { ...surface(p), display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 14 },
      content: (
        <>
          <strong style={{ fontSize: 26, color }}>{value}</strong>
          <span style={{ color: p.muted }}>{caption}</span>
        </>
      ),
    };
  },
  progress: (element, color, p) => {
    const [value, caption = ''] = labelParts(element.label);
    const percent = numberIn(value, 50, 0, 100);
    return {
      style: { display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6, color: p.ink, fontSize: 12 },
      content: (
        <>
          <span>{caption} {percent}%</span>
          <span style={{ height: 8, borderRadius: 999, background: p.line, overflow: 'hidden' }}>
            <span style={{ display: 'block', width: `${percent}%`, height: '100%', background: color }} />
          </span>
        </>
      ),
    };
  },
  pricing: (element, color, p) => {
    const [plan, price, ...features] = labelParts(element.label);
    return {
      style: { ...surface(p), border: `2px solid ${color}`, borderRadius: 16, padding: 18, display: 'flex', flexDirection: 'column', gap: 8 },
      content: (
        <>
          <span style={{ color, fontWeight: 600, textTransform: 'uppercase', fontSize: 12 }}>{plan}</span>
          <strong style={{ fontSize: 28, color: p.ink }}>{price}</strong>
          <span style={{ flex: 1, lineHeight: 1.8, color: p.ink }}>{features.map((feature, index) => <div key={index}>✓ {feature}</div>)}</span>
          <span style={{ ...flexCenter, background: color, color: '#fff', borderRadius: 8, padding: '8px 0' }}>Get started</span>
        </>
      ),
    };
  },
  testimonial: (element, color, p) => {
    const [text, author, role] = labelParts(element.label);
    return {
      style: { ...surface(p), padding: 16, display: 'flex', flexDirection: 'column', gap: 10 },
      content: (
        <>
          <span style={{ fontSize: 14, lineHeight: 1.5, color: p.ink }}>“{text}”</span>
          <span><strong style={{ color }}>{author}</strong> <span style={{ color: p.muted }}>{role}</span></span>
        </>
      ),
    };
  },
  tabs: (element, color, p) => ({
    style: { display: 'flex', alignItems: 'flex-end', gap: 18, borderBottom: `1px solid ${p.line}` },
    content: labelParts(element.label).map((tab, index) => (
      <span key={index} style={{ padding: '6px 2px', color: index === 0 ? color : p.muted, fontWeight: index === 0 ? 600 : 400, borderBottom: `2px solid ${index === 0 ? color : 'transparent'}` }}>
        {tab}
      </span>
    )),
  }),
  breadcrumb: (element, color, p) => {
    const crumbs = labelParts(element.label);
    return {
      style: { display: 'flex', alignItems: 'center', gap: 6 },
      content: crumbs.map((crumb, index) =>
        index === crumbs.length - 1 ? (
          <strong key={index} style={{ color: p.ink }}>{crumb}</strong>
        ) : (
          <span key={index} style={{ color }}>{crumb} <span style={{ color: p.muted }}>/</span></span>
        ),
      ),
    };
  },
  pagination: (element, color, p) => {
    const pages = numberIn(element.label, 3, 1, 9);
    const box = (text: string, active: boolean, key: string): JSX.Element => (
      <span key={key} style={{ ...flexCenter, minWidth: 28, height: 28, borderRadius: 8, border: `1px solid ${active ? color : p.line}`, background: active ? color : p.surface, color: active ? '#fff' : p.ink }}>
        {text}
      </span>
    );
    return {
      style: { display: 'flex', alignItems: 'center', gap: 5 },
      content: [box('‹', false, 'prev'), ...Array.from({ length: pages }, (_unused, index) => box(String(index + 1), index === 0, String(index))), box('›', false, 'next')],
    };
  },
  alert: (element, color, _p) => ({ style: { display: 'flex', alignItems: 'center', padding: '0 14px', background: `${color}14`, borderLeft: `4px solid ${color}`, borderRadius: 8, color }, content: element.label }),
  accordion: (element, color, p) => {
    const [title, body] = labelParts(element.label);
    return {
      style: { ...surface(p), borderRadius: 10, padding: '10px 14px' },
      content: (
        <>
          <strong style={{ color }}>▾ {title}</strong>
          <div style={{ marginTop: 6, color: p.muted, lineHeight: 1.5 }}>{body}</div>
        </>
      ),
    };
  },
  spinner: (element, color, _p) => ({
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

export function extendedPreview(type: ExtendedElementType, element: CanvasElement, color: string, palette: PreviewPalette): PreviewVisual {
  return PREVIEWS[type](element, color, palette);
}
