/**
 * A Page Builder page's theme - Realtime-Colors-style control over a page's
 * whole look: every colour token, the page's background, text, muted,
 * surface and border colours, and a heading/body font pairing.
 *
 * Still a closed, validated shape, never free-form CSS: colours must be
 * 6-digit hex, fonts come from FONTS below. A layout without a theme renders
 * exactly as it always has (DEFAULT_THEME only fills in missing values).
 */
import type { DesignToken } from './canvas-layout.js';

export interface FontSpec {
  readonly label: string;
  /** The CSS font-family stack emitted into the page. */
  readonly stack: string;
  /** Google Fonts family parameter; absent for system fonts (nothing is loaded). */
  readonly google?: string;
}

export const FONTS = {
  system: { label: 'System UI', stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  inter: { label: 'Inter', stack: "'Inter', system-ui, sans-serif", google: 'Inter:wght@400;600;700' },
  poppins: { label: 'Poppins', stack: "'Poppins', system-ui, sans-serif", google: 'Poppins:wght@400;600;700' },
  'dm-sans': { label: 'DM Sans', stack: "'DM Sans', system-ui, sans-serif", google: 'DM+Sans:wght@400;600;700' },
  'space-grotesk': { label: 'Space Grotesk', stack: "'Space Grotesk', system-ui, sans-serif", google: 'Space+Grotesk:wght@400;600;700' },
  montserrat: { label: 'Montserrat', stack: "'Montserrat', system-ui, sans-serif", google: 'Montserrat:wght@400;600;700' },
  'playfair-display': { label: 'Playfair Display', stack: "'Playfair Display', Georgia, serif", google: 'Playfair+Display:wght@400;700' },
  lora: { label: 'Lora', stack: "'Lora', Georgia, serif", google: 'Lora:wght@400;700' },
  merriweather: { label: 'Merriweather', stack: "'Merriweather', Georgia, serif", google: 'Merriweather:wght@400;700' },
  'jetbrains-mono': { label: 'JetBrains Mono', stack: "'JetBrains Mono', ui-monospace, monospace", google: 'JetBrains+Mono:wght@400;700' },
} as const satisfies Record<string, FontSpec>;

export type FontName = keyof typeof FONTS;
export const FONT_NAMES: readonly FontName[] = Object.keys(FONTS) as FontName[];

export interface PageTheme {
  /** Replaces each design token's colour. */
  readonly colors: Readonly<Record<DesignToken, string>>;
  readonly background: string;
  readonly text: string;
  readonly muted: string;
  /** Cards, tables, inputs. */
  readonly surface: string;
  /** Borders and dividers inside components. */
  readonly line: string;
  readonly headingFont: FontName;
  readonly bodyFont: FontName;
}

export const DEFAULT_THEME: PageTheme = {
  colors: {
    primary: '#2563eb',
    secondary: '#7c3aed',
    neutral: '#475569',
    danger: '#dc2626',
    success: '#16a34a',
    warning: '#d97706',
    dark: '#0f172a',
    light: '#f8fafc',
  },
  background: '#ffffff',
  text: '#0f172a',
  muted: '#64748b',
  surface: '#ffffff',
  line: '#e2e8f0',
  headingFont: 'system',
  bodyFont: 'system',
};

const HEX = /^#[0-9a-fA-F]{6}$/;

export type ThemeError = { readonly reason: 'invalid-theme-color'; readonly field: string; readonly value: string } | { readonly reason: 'unknown-font'; readonly field: string; readonly value: string };

export function validateTheme(theme: PageTheme): readonly ThemeError[] {
  const errors: ThemeError[] = [];
  const colors: Record<string, string> = { ...Object.fromEntries(Object.entries(theme.colors).map(([k, v]) => [`colors.${k}`, v])), background: theme.background, text: theme.text, muted: theme.muted, surface: theme.surface, line: theme.line };
  for (const [field, value] of Object.entries(colors)) {
    if (typeof value !== 'string' || !HEX.test(value)) errors.push({ reason: 'invalid-theme-color', field, value: String(value) });
  }
  for (const field of ['headingFont', 'bodyFont'] as const) {
    if (!(theme[field] in FONTS)) errors.push({ reason: 'unknown-font', field, value: String(theme[field]) });
  }
  for (const token of Object.keys(DEFAULT_THEME.colors)) {
    if (!(token in theme.colors)) errors.push({ reason: 'invalid-theme-color', field: `colors.${token}`, value: 'missing' });
  }
  return errors;
}

/** The Google Fonts stylesheet for the fonts a theme uses; null when both are system fonts. */
export function googleFontsUrl(theme: PageTheme): string | null {
  const families = [...new Set([FONTS[theme.headingFont], FONTS[theme.bodyFont]].flatMap((font): string[] => ('google' in font ? [font.google] : [])))];
  if (families.length === 0) return null;
  return `https://fonts.googleapis.com/css2?${families.map((family) => `family=${family}`).join('&')}&display=swap`;
}

/** WCAG 2.x relative luminance contrast ratio between two hex colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r = 0, g = 0, bl = 0] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
