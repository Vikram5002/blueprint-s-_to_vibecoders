import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CANVAS_ELEMENT_TYPES, layoutToComponentFile, type CanvasElement, type PageLayout } from './canvas-layout.js';
import { EXTENDED_ELEMENT_TYPES } from './canvas-elements.js';

function page(elements: readonly CanvasElement[]): PageLayout {
  return { id: 'layout-1', pageName: 'Landing Page', elements };
}

function element(overrides: Partial<CanvasElement> & Pick<CanvasElement, 'type'>): CanvasElement {
  return { id: 'el-1', x: 10, y: 20, width: 400, height: 200, label: 'Content', colorToken: 'primary', ...overrides };
}

function render(overrides: Partial<CanvasElement> & Pick<CanvasElement, 'type'>): string {
  return layoutToComponentFile(page([element(overrides)])).contents;
}

/** Syntax errors a real TSX parse reports - the generated file must be valid source, whatever the label says. */
function syntaxErrors(source: string): readonly string[] {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
    fileName: 'page.tsx',
  });
  return (result.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('extended page-builder elements', () => {
  it('adds the website-builder catalogue on top of the twelve basic controls', () => {
    expect(CANVAS_ELEMENT_TYPES.length).toBe(12 + EXTENDED_ELEMENT_TYPES.length);
    expect(EXTENDED_ELEMENT_TYPES).toEqual(expect.arrayContaining(['navbar', 'hero', 'card', 'pricing', 'table', 'tabs', 'video', 'toggle', 'accordion']));
  });

  it('every element type generates valid TSX, even with hostile label text', () => {
    const hostile = 'Say "hi" | <b>bold</b> & {braces} | it\'s, a, row | https://example.com/x.png';
    const elements = CANVAS_ELEMENT_TYPES.map((type, index) =>
      element({ id: `el-${index + 1}`, type, label: hostile, x: 0, y: 0, width: 300, height: 100 }),
    );
    const source = layoutToComponentFile(page(elements)).contents;
    expect(syntaxErrors(source)).toEqual([]);
    for (let index = 1; index <= elements.length; index += 1) expect(source).toContain(`data-testid="el-${index}"`);
  });

  it('splits multi-part labels on |', () => {
    const nav = render({ type: 'navbar', label: 'Acme|Home|Pricing' });
    expect(nav).toContain('<nav');
    expect(nav).toContain('>Acme</strong>');
    expect(nav).toContain('>Home</a>');
    expect(nav).toContain('>Pricing</a>');
    const hero = render({ type: 'hero', label: 'Ship faster|The subtitle|Get started' });
    expect(hero).toContain('>Ship faster</h1>');
    expect(hero).toContain('>Get started</button>');
  });

  it('renders a table with a header row and comma-separated cells', () => {
    const table = render({ type: 'table', label: 'Name,Price|Tea,$3|Cake,$5' });
    expect(table).toContain('>Name</th>');
    expect(table).toContain('>Price</th>');
    expect(table.match(/<tr>/g)).toHaveLength(3);
    expect(table).toContain('>$5</td>');
  });

  it('clamps numeric labels for rating and progress', () => {
    expect(render({ type: 'rating', label: '9' })).toContain('★★★★★');
    expect(render({ type: 'rating', label: '2' })).toContain('★★☆☆☆');
    expect(render({ type: 'progress', label: '150|Upload' })).toContain("width: '100%'");
  });

  it('embeds a YouTube link, plays a direct video URL, and never fabricates a source', () => {
    expect(render({ type: 'video', label: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(render({ type: 'video', label: 'https://cdn.example.com/a.mp4' })).toContain('<video');
    const placeholder = render({ type: 'video', label: 'Product demo' });
    expect(placeholder).not.toContain('<video');
    expect(placeholder).not.toContain('<iframe');
  });

  it('renders a real <img> only for an http(s) image URL', () => {
    expect(render({ type: 'image', label: 'https://example.com/photo.jpg' })).toContain('<img data-testid="el-1" src="https://example.com/photo.jpg"');
    expect(render({ type: 'image', label: 'javascript:alert(1)' })).not.toContain('<img');
  });

  it('uses real form controls with the right input types', () => {
    for (const type of ['email', 'password', 'number', 'date', 'search'] as const) {
      expect(render({ type, label: 'Field' })).toContain(`<input type="${type}"`);
    }
    expect(render({ type: 'slider' })).toContain('<input type="range"');
    expect(render({ type: 'toggle' })).toContain('role="switch"');
    expect(render({ type: 'file' })).toContain('<input type="file"');
  });

  it('emits the spin keyframes only when a spinner is on the page', () => {
    expect(render({ type: 'spinner' })).toContain('@keyframes vb-spin');
    expect(render({ type: 'card' })).not.toContain('<style>');
  });

  it('escapes a quote in an attribute instead of ending the string early', () => {
    expect(render({ type: 'input', label: 'Say "hi"' })).toContain('placeholder="Say &quot;hi&quot;"');
  });
});
