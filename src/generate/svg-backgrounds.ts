/**
 * Haikei-style SVG backgrounds for the Page Builder: waves, layered waves,
 * blobs, a blob scene, layered peaks, circle scatter and a mesh gradient.
 *
 * Deterministic: every shape comes from a seeded PRNG, so the same seed,
 * size and colours always produce the same SVG - "new shape" in the editor
 * just picks another seed. No randomness reaches the generated page.
 *
 * The same code renders the editor preview (HTML attribute names, via
 * ui/src/workspace/svg-backgrounds.ts, a verbatim copy - rule 4) and the
 * generated page (JSX attribute names), so the two can never disagree.
 */

export const BACKGROUND_KINDS = ['waves', 'layered-waves', 'blob', 'blob-scene', 'peaks', 'circles', 'mesh-gradient'] as const;
export type BackgroundKind = (typeof BACKGROUND_KINDS)[number];

export interface BackgroundSpec {
  /** Unique per element - scopes gradient ids so two backgrounds on a page never collide. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly color: string;
  /** The page background, blended into for layered shapes. */
  readonly background: string;
  readonly seed: number;
  /** 1-10: how many points, layers or shapes. */
  readonly complexity: number;
}

type Flavor = 'jsx' | 'html';

/** mulberry32: small, fast, deterministic. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixes two hex colours; t = 0 gives a, t = 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const channel = (hex: string, i: number): number => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t).toString(16).padStart(2, '0')).join('')}`;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** A smooth open curve through points (Catmull-Rom as cubic Beziers). */
function smoothPath(points: readonly (readonly [number, number])[]): string {
  const [first, ...rest] = points;
  if (first === undefined) return '';
  let d = `M${r1(first[0])},${r1(first[1])}`;
  for (let i = 0; i < rest.length; i += 1) {
    const p0 = points[Math.max(0, i - 1)] ?? first;
    const p1 = points[i] ?? first;
    const p2 = points[i + 1] ?? p1;
    const p3 = points[Math.min(points.length - 1, i + 2)] ?? p2;
    d += ` C${r1(p1[0] + (p2[0] - p0[0]) / 6)},${r1(p1[1] + (p2[1] - p0[1]) / 6)} ${r1(p2[0] - (p3[0] - p1[0]) / 6)},${r1(p2[1] - (p3[1] - p1[1]) / 6)} ${r1(p2[0])},${r1(p2[1])}`;
  }
  return d;
}

/** A smooth closed curve through points. */
function smoothClosed(points: readonly (readonly [number, number])[]): string {
  const n = points.length;
  const at = (i: number): readonly [number, number] => points[((i % n) + n) % n] ?? [0, 0];
  let d = `M${r1(at(0)[0])},${r1(at(0)[1])}`;
  for (let i = 0; i < n; i += 1) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    d += ` C${r1(p1[0] + (p2[0] - p0[0]) / 6)},${r1(p1[1] + (p2[1] - p0[1]) / 6)} ${r1(p2[0] - (p3[0] - p1[0]) / 6)},${r1(p2[1] - (p3[1] - p1[1]) / 6)} ${r1(p2[0])},${r1(p2[1])}`;
  }
  return `${d} Z`;
}

function wavePath(width: number, height: number, baseline: number, amplitude: number, points: number, random: () => number): string {
  const pts: [number, number][] = [];
  for (let i = 0; i <= points; i += 1) pts.push([(width * i) / points, baseline + (random() - 0.5) * 2 * amplitude]);
  return `${smoothPath(pts)} L${width},${height} L0,${height} Z`;
}

function blobPath(cx: number, cy: number, radius: number, points: number, random: () => number): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < points; i += 1) {
    const angle = (Math.PI * 2 * i) / points;
    const r = radius * (0.72 + random() * 0.5);
    pts.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  return smoothClosed(pts);
}

interface Shape {
  readonly d?: string;
  readonly circle?: { readonly cx: number; readonly cy: number; readonly r: number };
  readonly fill: string;
  readonly opacity: number;
}

function shapesFor(kind: BackgroundKind, spec: BackgroundSpec): readonly Shape[] {
  const random = prng(spec.seed);
  const { width: w, height: h, color, background } = spec;
  const k = Math.min(10, Math.max(1, Math.round(spec.complexity)));
  switch (kind) {
    case 'waves':
      return [{ d: wavePath(w, h, h * 0.45, h * 0.18, k + 2, random), fill: color, opacity: 1 }];
    case 'layered-waves': {
      const layers = 2 + Math.ceil(k / 3);
      return Array.from({ length: layers }, (_u, i) => ({
        d: wavePath(w, h, h * (0.25 + (0.6 * i) / layers), h * 0.12, k + 2, random),
        fill: mix(mix(color, background, 0.75), color, i / Math.max(1, layers - 1)),
        opacity: 1,
      }));
    }
    case 'blob':
      return [{ d: blobPath(w / 2, h / 2, Math.min(w, h) * 0.38, 4 + k, random), fill: color, opacity: 1 }];
    case 'blob-scene':
      return Array.from({ length: 2 + Math.ceil(k / 2) }, (_u, i) => ({
        d: blobPath(random() * w, random() * h, Math.min(w, h) * (0.18 + random() * 0.22), 5 + (k % 4), random),
        fill: mix(color, background, (i % 3) * 0.28),
        opacity: 0.85,
      }));
    case 'peaks': {
      const layers = 2 + Math.ceil(k / 3);
      return Array.from({ length: layers }, (_u, i) => {
        const base = h * (0.3 + (0.55 * i) / layers);
        const count = 3 + k;
        const pts = Array.from({ length: count + 1 }, (_v, j) => `${r1((w * j) / count)},${r1(base - random() * h * 0.28)}`);
        return { d: `M0,${h} L${pts.join(' L')} L${w},${h} Z`, fill: mix(mix(color, background, 0.7), color, i / Math.max(1, layers - 1)), opacity: 1 };
      });
    }
    case 'circles':
      return Array.from({ length: 4 + k * 2 }, () => ({
        circle: { cx: r1(random() * w), cy: r1(random() * h), r: r1(Math.min(w, h) * (0.03 + random() * 0.14)) },
        fill: mix(color, background, random() * 0.6),
        opacity: r1(0.35 + random() * 0.55),
      }));
    case 'mesh-gradient':
      return [];
  }
}

/** The background as an <svg>, in JSX or plain-HTML attribute spelling. */
export function renderBackgroundSvg(kind: BackgroundKind, spec: BackgroundSpec, flavor: Flavor): string {
  const fillOpacity = flavor === 'jsx' ? 'fillOpacity' : 'fill-opacity';
  const stopColor = flavor === 'jsx' ? 'stopColor' : 'stop-color';
  const open = `<svg viewBox="0 0 ${spec.width} ${spec.height}" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true">`;
  if (kind === 'mesh-gradient') {
    const random = prng(spec.seed);
    const stops = Math.min(6, 2 + Math.ceil(spec.complexity / 2));
    const gradients: string[] = [];
    const rects: string[] = [];
    for (let i = 0; i < stops; i += 1) {
      const gid = `vb-${spec.id}-g${i}`;
      const fill = i % 2 === 0 ? spec.color : mix(spec.color, '#ffffff', 0.45 + random() * 0.3);
      gradients.push(`<radialGradient id="${gid}" cx="${r1(random() * 100)}%" cy="${r1(random() * 100)}%" r="${r1(45 + random() * 40)}%"><stop offset="0%" ${stopColor}="${fill}" /><stop offset="100%" ${stopColor}="${fill}" ${flavor === 'jsx' ? 'stopOpacity' : 'stop-opacity'}="0" /></radialGradient>`);
      rects.push(`<rect width="100%" height="100%" fill="url(#${gid})" />`);
    }
    return `${open}<defs>${gradients.join('')}</defs><rect width="100%" height="100%" fill="${mix(spec.color, spec.background, 0.6)}" />${rects.join('')}</svg>`;
  }
  const body = shapesFor(kind, spec)
    .map((shape) =>
      shape.circle !== undefined
        ? `<circle cx="${shape.circle.cx}" cy="${shape.circle.cy}" r="${shape.circle.r}" fill="${shape.fill}" ${fillOpacity}="${shape.opacity}" />`
        : `<path d="${shape.d ?? ''}" fill="${shape.fill}"${shape.opacity === 1 ? '' : ` ${fillOpacity}="${shape.opacity}"`} />`,
    )
    .join('');
  return `${open}${body}</svg>`;
}

/** "42|6" -> seed 42, complexity 6; anything unparsable falls back to sensible defaults. */
export function parseBackgroundLabel(label: string): { readonly seed: number; readonly complexity: number } {
  const [seedText = '', complexityText = ''] = label.split('|').map((part) => part.trim());
  const seed = Number.parseInt(seedText, 10);
  const complexity = Number.parseInt(complexityText, 10);
  return {
    seed: Number.isFinite(seed) ? Math.abs(seed) : 1,
    complexity: Number.isFinite(complexity) ? Math.min(10, Math.max(1, complexity)) : 5,
  };
}
