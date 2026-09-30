import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  PRESETS,
  contrastGrade,
  contrastRatio,
  isDark,
  randomTheme,
  themeAsCss,
  themeFromHue,
  toggleDark,
} from './page-theme';

const HEX = /^#[0-9a-f]{6}$/;
const colorsOf = (t: typeof DEFAULT_THEME): string[] => [
  ...Object.values(t.colors),
  t.background,
  t.text,
  t.muted,
  t.surface,
  t.line,
];

describe('page themes (editor)', () => {
  it('every preset and generated theme is valid 6-digit hex', () => {
    for (const { theme } of PRESETS) for (const c of colorsOf(theme)) expect(c).toMatch(HEX);
    for (let hue = 0; hue < 360; hue += 37)
      for (const c of colorsOf(themeFromHue(hue, hue % 2 === 0))) expect(c).toMatch(HEX);
  });

  it('generated themes keep body text readable (at least WCAG AA)', () => {
    for (let hue = 0; hue < 360; hue += 30) {
      for (const dark of [false, true]) {
        const t = themeFromHue(hue, dark);
        expect(contrastRatio(t.text, t.background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('shuffle keeps light or dark, and toggle flips it', () => {
    let seed = 0.42;
    const random = (): number => (seed = (seed * 9301 + 0.49297) % 1);
    const darkTheme = themeFromHue(200, true);
    expect(isDark(randomTheme(darkTheme, random))).toBe(true);
    expect(isDark(toggleDark(DEFAULT_THEME))).toBe(true);
    expect(isDark(toggleDark(darkTheme))).toBe(false);
  });

  it('grades contrast like WCAG', () => {
    expect(contrastGrade(21)).toBe('AAA');
    expect(contrastGrade(5)).toBe('AA');
    expect(contrastGrade(3.2)).toBe('AA large');
    expect(contrastGrade(1.5)).toBe('Fail');
  });

  it('exports CSS variables', () => {
    expect(themeAsCss(DEFAULT_THEME)).toContain('--primary: #2563eb;');
  });
});
