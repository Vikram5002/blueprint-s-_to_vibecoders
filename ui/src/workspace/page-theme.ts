/**
 * Mirrors src/generate/page-theme.ts (rule 4: ui/ never imports src/), plus
 * the editor-only helpers a Realtime-Colors-style theme panel needs: preset
 * palettes, a random harmonious palette, light/dark flipping, and exports.
 */
import type { DesignToken } from './page-builder-types';

export const FONTS = {
  system: { label: 'System UI', stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", google: null },
  inter: { label: 'Inter', stack: "'Inter', system-ui, sans-serif", google: 'Inter:wght@400;600;700' },
  poppins: { label: 'Poppins', stack: "'Poppins', system-ui, sans-serif", google: 'Poppins:wght@400;600;700' },
  'dm-sans': { label: 'DM Sans', stack: "'DM Sans', system-ui, sans-serif", google: 'DM+Sans:wght@400;600;700' },
  'space-grotesk': { label: 'Space Grotesk', stack: "'Space Grotesk', system-ui, sans-serif", google: 'Space+Grotesk:wght@400;600;700' },
  montserrat: { label: 'Montserrat', stack: "'Montserrat', system-ui, sans-serif", google: 'Montserrat:wght@400;600;700' },
  'playfair-display': { label: 'Playfair Display', stack: "'Playfair Display', Georgia, serif", google: 'Playfair+Display:wght@400;700' },
  lora: { label: 'Lora', stack: "'Lora', Georgia, serif", google: 'Lora:wght@400;700' },
  merriweather: { label: 'Merriweather', stack: "'Merriweather', Georgia, serif", google: 'Merriweather:wght@400;700' },
  'jetbrains-mono': { label: 'JetBrains Mono', stack: "'JetBrains Mono', ui-monospace, monospace", google: 'JetBrains+Mono:wght@400;700' },
} as const;

export type FontName = keyof typeof FONTS;
export const FONT_NAMES = Object.keys(FONTS) as FontName[];

export interface PageTheme {
  readonly colors: Readonly<Record<DesignToken, string>>;
  readonly background: string;
  readonly text: string;
  readonly muted: string;
  readonly surface: string;
  readonly line: string;
  readonly headingFont: FontName;
  readonly bodyFont: FontName;
}

export const DEFAULT_THEME: PageTheme = {
  colors: { primary: '#2563eb', secondary: '#7c3aed', neutral: '#475569', danger: '#dc2626', success: '#16a34a', warning: '#d97706', dark: '#0f172a', light: '#f8fafc' },
  background: '#ffffff',
  text: '#0f172a',
  muted: '#64748b',
  surface: '#ffffff',
  line: '#e2e8f0',
  headingFont: 'system',
  bodyFont: 'system',
};

// ---- colour maths ---------------------------------------------------------------

function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

export function hsl(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number): number => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG contrast ratio, 1-21. */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r = 0, g = 0, bl = 0] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export function contrastGrade(ratio: number): 'AAA' | 'AA' | 'AA large' | 'Fail' {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA large';
  return 'Fail';
}

export function isDark(theme: PageTheme): boolean {
  return hexToHsl(theme.background)[2] < 45;
}

// ---- palettes -------------------------------------------------------------------

/** A full theme from one brand hue: harmonious secondary/accents, light or dark surfaces. */
export function themeFromHue(hue: number, dark: boolean, fonts: Pick<PageTheme, 'headingFont' | 'bodyFont'> = DEFAULT_THEME): PageTheme {
  const h = ((hue % 360) + 360) % 360;
  return {
    colors: {
      primary: hsl(h, 78, dark ? 62 : 50),
      secondary: hsl(h + 150, 65, dark ? 66 : 52),
      neutral: hsl(h, 12, dark ? 60 : 42),
      danger: hsl(356, 78, dark ? 62 : 50),
      success: hsl(145, 60, dark ? 52 : 38),
      warning: hsl(36, 90, dark ? 58 : 48),
      dark: hsl(h, 30, dark ? 90 : 12),
      light: hsl(h, 30, dark ? 14 : 97),
    },
    background: dark ? hsl(h, 22, 7) : hsl(h, 30, 99),
    text: dark ? hsl(h, 20, 94) : hsl(h, 35, 11),
    muted: dark ? hsl(h, 10, 64) : hsl(h, 12, 42),
    surface: dark ? hsl(h, 20, 11) : '#ffffff',
    line: dark ? hsl(h, 14, 20) : hsl(h, 22, 90),
    headingFont: fonts.headingFont,
    bodyFont: fonts.bodyFont,
  };
}

const FONT_PAIRS: readonly [FontName, FontName][] = [
  ['playfair-display', 'inter'],
  ['space-grotesk', 'dm-sans'],
  ['montserrat', 'lora'],
  ['poppins', 'inter'],
  ['merriweather', 'dm-sans'],
  ['inter', 'inter'],
];

/** Realtime Colors' "shuffle": a random harmonious palette and font pairing, keeping light/dark as it is. */
export function randomTheme(current: PageTheme, random: () => number = Math.random): PageTheme {
  const [headingFont, bodyFont] = FONT_PAIRS[Math.floor(random() * FONT_PAIRS.length)] ?? ['inter', 'inter'];
  return themeFromHue(Math.floor(random() * 360), isDark(current), { headingFont, bodyFont });
}

/** The same palette, flipped between light and dark. */
export function toggleDark(theme: PageTheme): PageTheme {
  return themeFromHue(hexToHsl(theme.colors.primary)[0], !isDark(theme), { headingFont: theme.headingFont, bodyFont: theme.bodyFont });
}

export const PRESETS: readonly { readonly name: string; readonly theme: PageTheme }[] = [
  { name: 'Default', theme: DEFAULT_THEME },
  { name: 'Ocean', theme: themeFromHue(205, false, { headingFont: 'space-grotesk', bodyFont: 'dm-sans' }) },
  { name: 'Forest', theme: themeFromHue(150, false, { headingFont: 'merriweather', bodyFont: 'inter' }) },
  { name: 'Sunset', theme: themeFromHue(18, false, { headingFont: 'poppins', bodyFont: 'inter' }) },
  { name: 'Royal', theme: themeFromHue(265, false, { headingFont: 'playfair-display', bodyFont: 'inter' }) },
  { name: 'Midnight', theme: themeFromHue(230, true, { headingFont: 'space-grotesk', bodyFont: 'inter' }) },
  { name: 'Neon', theme: themeFromHue(320, true, { headingFont: 'montserrat', bodyFont: 'dm-sans' }) },
];

// ---- exports --------------------------------------------------------------------

export function themeAsCss(theme: PageTheme): string {
  const lines = [
    ...Object.entries(theme.colors).map(([token, hex]) => `  --${token}: ${hex};`),
    `  --background: ${theme.background};`,
    `  --text: ${theme.text};`,
    `  --muted: ${theme.muted};`,
    `  --surface: ${theme.surface};`,
    `  --line: ${theme.line};`,
    `  --font-heading: ${FONTS[theme.headingFont].stack};`,
    `  --font-body: ${FONTS[theme.bodyFont].stack};`,
  ];
  return `:root {\n${lines.join('\n')}\n}\n`;
}

export function themeAsTailwind(theme: PageTheme): string {
  const colors = { ...theme.colors, background: theme.background, text: theme.text, muted: theme.muted, surface: theme.surface, line: theme.line };
  return `// tailwind.config.js - theme.extend
export default {
  theme: {
    extend: {
      colors: ${JSON.stringify(colors, null, 8).replace(/\n}/, '\n      }')},
      fontFamily: {
        heading: [${JSON.stringify(FONTS[theme.headingFont].stack)}],
        body: [${JSON.stringify(FONTS[theme.bodyFont].stack)}],
      },
    },
  },
};
`;
}
