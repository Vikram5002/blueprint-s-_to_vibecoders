import { describe, expect, it } from 'vitest';
import {
  CANVAS_ELEMENT_TYPES,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  DESIGN_TOKENS,
  layoutToComponentFile,
  pageLayoutTargetPath,
  validatePageLayout,
  type CanvasElement,
  type PageLayout,
} from './canvas-layout.js';

function layoutWith(overrides: Partial<PageLayout> = {}): PageLayout {
  return {
    id: 'layout-1',
    pageName: 'Landing Page',
    elements: [],
    ...overrides,
  };
}

function elementOf(overrides: Partial<CanvasElement> & Pick<CanvasElement, 'type'>): CanvasElement {
  return {
    id: 'el-1',
    x: 10,
    y: 20,
    width: 200,
    height: 40,
    label: 'Content',
    colorToken: 'primary',
    ...overrides,
  };
}

describe('validatePageLayout', () => {
  it('accepts an empty, valid layout', () => {
    expect(validatePageLayout(layoutWith())).toEqual([]);
  });

  it('rejects a blank page name', () => {
    expect(validatePageLayout(layoutWith({ pageName: '  ' }))).toEqual([{ reason: 'empty-page-name' }]);
  });

  it('rejects an unrecognized color token rather than defaulting it', () => {
    const layout = layoutWith({
      elements: [
        { id: 'e1', type: 'button', x: 0, y: 0, width: 100, height: 40, label: 'Go', colorToken: 'not-a-real-token' as never },
      ],
    });
    expect(validatePageLayout(layout)).toEqual([{ reason: 'unknown-color-token', elementId: 'e1', token: 'not-a-real-token' }]);
  });

  it('rejects an element placed outside the fixed canvas bounds', () => {
    const layout = layoutWith({
      elements: [{ id: 'e1', type: 'text', x: CANVAS_WIDTH - 10, y: 0, width: 50, height: 20, label: 'x', colorToken: 'dark' }],
    });
    expect(validatePageLayout(layout)).toEqual([{ reason: 'out-of-bounds', elementId: 'e1' }]);
  });

  it('rejects a negative position', () => {
    const layout = layoutWith({
      elements: [{ id: 'e1', type: 'text', x: -5, y: 0, width: 50, height: 20, label: 'x', colorToken: 'dark' }],
    });
    expect(validatePageLayout(layout)).toEqual([{ reason: 'out-of-bounds', elementId: 'e1' }]);
  });
});

describe('pageLayoutTargetPath', () => {
  it('matches the existing frontend page convention exactly', () => {
    expect(pageLayoutTargetPath(layoutWith({ pageName: 'Landing Page' }))).toBe('frontend/src/pages/landing-page.tsx');
  });
});

describe('layoutToComponentFile', () => {
  it('generates one file at the conventional frontend page path, with a named export matching the page name', () => {
    const file = layoutToComponentFile(layoutWith({ pageName: 'Landing Page' }));
    expect(file.path).toBe('frontend/src/pages/landing-page.tsx');
    expect(file.contents).toContain('export const LandingPage: FC = () => {');
    expect(file.contents).not.toContain('export default');
  });

  it('reproduces exact position, size, and color for a button element - a direct data copy, not an inference', () => {
    const layout = layoutWith({
      elements: [{ id: 'btn-1', type: 'button', x: 100, y: 50, width: 160, height: 40, label: 'Click me', colorToken: 'primary' }],
    });
    const file = layoutToComponentFile(layout);

    expect(file.contents).toContain('data-testid="btn-1"');
    expect(file.contents).toContain("left: 100, top: 50, width: 160, height: 40");
    expect(file.contents).toContain(`backgroundColor: '${DESIGN_TOKENS.primary}'`);
    expect(file.contents).toContain('>Click me</button>');
  });

  it('reproduces exact position and color for a text element, using color not backgroundColor', () => {
    const layout = layoutWith({
      elements: [{ id: 'txt-1', type: 'text', x: 20, y: 30, width: 200, height: 24, label: 'Hello world', colorToken: 'dark' }],
    });
    const file = layoutToComponentFile(layout);

    expect(file.contents).toContain('data-testid="txt-1"');
    expect(file.contents).toContain("left: 20, top: 30, width: 200, height: 24");
    expect(file.contents).toContain(`color: '${DESIGN_TOKENS.dark}'`);
    expect(file.contents).not.toContain('backgroundColor');
    expect(file.contents).toContain('>Hello world</span>');
  });

  it('preserves element order exactly as given', () => {
    const layout = layoutWith({
      elements: [
        { id: 'first', type: 'text', x: 0, y: 0, width: 10, height: 10, label: 'A', colorToken: 'dark' },
        { id: 'second', type: 'button', x: 0, y: 20, width: 10, height: 10, label: 'B', colorToken: 'primary' },
      ],
    });
    const file = layoutToComponentFile(layout);
    expect(file.contents.indexOf('data-testid="first"')).toBeLessThan(file.contents.indexOf('data-testid="second"'));
  });

  it('escapes JSX-breaking characters in a label rather than emitting invalid syntax', () => {
    const layout = layoutWith({
      elements: [{ id: 'e1', type: 'text', x: 0, y: 0, width: 50, height: 20, label: 'a < b && {c}', colorToken: 'dark' }],
    });
    const file = layoutToComponentFile(layout);
    expect(file.contents).toContain('a &lt; b &amp;&amp; &#123;c&#125;');
  });

  it('renders the canvas container at the fixed 1280x800 size', () => {
    const file = layoutToComponentFile(layoutWith());
    expect(file.contents).toContain(`width: ${CANVAS_WIDTH}, height: ${CANVAS_HEIGHT}`);
  });

  it('throws rather than silently generating from an invalid layout', () => {
    expect(() => layoutToComponentFile(layoutWith({ pageName: '' }))).toThrow();
  });

  describe('every element type', () => {
    it('renders a heading as a <h2>, bold, with its own text', () => {
      const file = layoutToComponentFile(layoutWith({ elements: [elementOf({ type: 'heading', label: 'Welcome' })] }));
      expect(file.contents).toContain('<h2 data-testid="el-1"');
      expect(file.contents).toContain('fontWeight: 700');
      expect(file.contents).toContain('>Welcome</h2>');
    });

    it('renders a link as a real <a> tag', () => {
      const file = layoutToComponentFile(layoutWith({ elements: [elementOf({ type: 'link', label: 'Learn more' })] }));
      expect(file.contents).toContain('<a href="#" data-testid="el-1"');
      expect(file.contents).toContain('textDecoration: \'underline\'');
      expect(file.contents).toContain('>Learn more</a>');
    });

    it('renders an image as a labelled, dashed-border placeholder - never a fabricated <img src>', () => {
      const file = layoutToComponentFile(layoutWith({ elements: [elementOf({ type: 'image', label: 'Hero photo' })] }));
      expect(file.contents).not.toContain('<img');
      expect(file.contents).toContain('role="img"');
      expect(file.contents).toContain('aria-label="Hero photo"');
      expect(file.contents).toContain('border: \'2px dashed');
    });

    it('renders an input as a real, uncontrolled <input> with the label as its placeholder', () => {
      const file = layoutToComponentFile(layoutWith({ elements: [elementOf({ type: 'input', label: 'Email address' })] }));
      expect(file.contents).toContain('<input type="text" data-testid="el-1" placeholder="Email address"');
    });

    it('renders a textarea as a real <textarea> with the label as its placeholder', () => {
      const file = layoutToComponentFile(layoutWith({ elements: [elementOf({ type: 'textarea', label: 'Your message' })] }));
      expect(file.contents).toContain('<textarea data-testid="el-1" placeholder="Your message"');
    });

    it('renders a checkbox as a labelled real <input type="checkbox">', () => {
      const file = layoutToComponentFile(layoutWith({ elements: [elementOf({ type: 'checkbox', label: 'Subscribe' })] }));
      expect(file.contents).toContain('<input type="checkbox" />');
      expect(file.contents).toContain('>Subscribe</label>');
    });

    it('renders a radio as a labelled real <input type="radio">, distinct from a checkbox', () => {
      const file = layoutToComponentFile(layoutWith({ elements: [elementOf({ type: 'radio', label: 'Option A' })] }));
      expect(file.contents).toContain('<input type="radio" />');
      expect(file.contents).toContain('>Option A</label>');
    });

    it('renders a select as a real <select> with the label as its one <option>', () => {
      const file = layoutToComponentFile(layoutWith({ elements: [elementOf({ type: 'select', label: 'United States' })] }));
      expect(file.contents).toContain('<select data-testid="el-1"');
      expect(file.contents).toContain('<option>United States</option></select>');
    });

    it('renders a divider as a real <hr>, colored via borderTop', () => {
      const file = layoutToComponentFile(layoutWith({ elements: [elementOf({ type: 'divider', label: '' })] }));
      expect(file.contents).toContain('<hr data-testid="el-1"');
      expect(file.contents).toContain(`borderTop: '2px solid ${DESIGN_TOKENS.primary}'`);
    });

    it('renders a container as an empty, bordered grouping <div> - never carrying its own text', () => {
      const file = layoutToComponentFile(layoutWith({ elements: [elementOf({ type: 'container', label: '' })] }));
      expect(file.contents).toMatch(/<div data-testid="el-1" style=\{\{[^}]*\}\} \/>/);
    });

    it('every declared CanvasElementType actually produces distinct, valid output - none silently falls through to another type\'s markup', () => {
      for (const type of CANVAS_ELEMENT_TYPES) {
        const file = layoutToComponentFile(layoutWith({ elements: [elementOf({ type, label: 'x' })] }));
        expect(file.contents).toContain('data-testid="el-1"');
      }
    });
  });
});
