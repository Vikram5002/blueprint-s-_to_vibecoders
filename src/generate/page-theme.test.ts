import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CANVAS_ELEMENT_TYPES, layoutToComponentFile, validatePageLayout, type CanvasElement, type PageLayout } from './canvas-layout.js';
import { DEFAULT_THEME, contrastRatio, googleFontsUrl, type PageTheme } from './page-theme.js';

const dark: PageTheme = {
  ...DEFAULT_THEME,
  colors: { ...DEFAULT_THEME.colors, primary: '#ff2d55' },
  background: '#0b0b10',
  text: '#f5f5f7',
  muted: '#9a9aa5',
  surface: '#16161d',
  line: '#2a2a33',
  headingFont: 'playfair-display',
  bodyFont: 'inter',
};

const element = (overrides: Partial<CanvasElement> & Pick<CanvasElement, 'type'>): CanvasElement => ({
  id: 'el-1', x: 0, y: 0, width: 300, height: 100, label: 'Title|Body|Go', colorToken: 'primary', ...overrides,
});
const page = (elements: readonly CanvasElement[], theme?: PageTheme): PageLayout => ({ id: 'p', pageName: 'Home', elements, ...(theme === undefined ? {} : { theme }) });

function syntaxErrors(source: string): readonly string[] {
  const result = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 }, fileName: 'p.tsx' });
  return (result.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('page themes', () => {
  it('colours the page root and elements from the theme, and loads its fonts', () => {
    const source = layoutToComponentFile(page([element({ type: 'button', label: 'Go' }), element({ id: 'el-2', type: 'card' })], dark)).contents;
    expect(source).toContain("backgroundColor: '#0b0b10', color: '#f5f5f7'");
    expect(source).toContain("backgroundColor: '#ff2d55'");
    expect(source).toContain("background: '#16161d'");
    expect(source).toContain("@import url('https://fonts.googleapis.com/css2?family=Playfair+Display");
    expect(source).toContain('--vb-primary: #ff2d55;');
    expect(source).toContain('h1, h2, h3 { font-family:');
  });

  it('every element type is valid TSX under a theme', () => {
    const elements = CANVAS_ELEMENT_TYPES.map((type, i) => element({ id: `el-${i}`, type }));
    expect(syntaxErrors(layoutToComponentFile(page(elements, dark)).contents)).toEqual([]);
  });

  it('an unthemed page carries no theme styles at all', () => {
    const source = layoutToComponentFile(page([element({ type: 'card' })])).contents;
    expect(source).not.toContain('--vb-');
    expect(source).not.toContain('fonts.googleapis');
  });

  it('rejects a colour that is not 6-digit hex, and an unknown font', () => {
    const bad = { ...dark, background: 'red', headingFont: 'comic-sans' } as unknown as PageTheme;
    expect(validatePageLayout(page([], bad))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'invalid-theme-color', field: 'background' }),
        expect.objectContaining({ reason: 'unknown-font', field: 'headingFont' }),
      ]),
    );
  });

  it('loads no web fonts for system fonts', () => {
    expect(googleFontsUrl(DEFAULT_THEME)).toBeNull();
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });
});
