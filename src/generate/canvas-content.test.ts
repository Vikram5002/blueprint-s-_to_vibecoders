import { describe, expect, it } from 'vitest';
import { layoutToComponentFile, type CanvasElement } from './canvas-layout.js';
import { contentRuntime } from './canvas-content.js';

const element = (type: CanvasElement['type'], label: string, id = 'el-1'): CanvasElement => ({ id, type, x: 0, y: 0, width: 400, height: 200, label, colorToken: 'primary' });
const source = (elements: readonly CanvasElement[]): string => layoutToComponentFile({ id: 'p', pageName: 'Home', elements }).contents;

describe('content blocks', () => {
  it('draws charts at generation time from the numbers in the label', () => {
    const bars = source([element('bar-chart', 'Jan 12|Feb 24')]);
    expect(bars.match(/<rect /g)).toHaveLength(2);
    expect(bars).toContain('>24</text>');
    // The fit-to-screen hook is the page's only state; the chart itself has none.
    expect(bars.match(/useState\(/g)).toHaveLength(1);
  });

  it('computes a calendar month with the marked days', () => {
    const cal = source([element('calendar', '2026-10|5,12')]);
    expect(cal).toContain('October 2026');
    expect(cal.match(/>31<\/span>/g)).toHaveLength(1);
  });

  it('ships a QR code as a finished SVG - no helper, no service', () => {
    const qr = source([element('qr-code', 'https://example.com')]);
    expect(qr).toContain('aria-label="QR code"');
    expect(qr).not.toContain('function Vb');
    expect(qr).not.toContain('http://api');
  });

  it('never invents a media source: a non-URL label is a placeholder', () => {
    expect(source([element('embed', 'not a url')])).not.toContain('<iframe');
    expect(source([element('audio', 'x|Podcast')])).not.toContain('<audio');
  });

  it('interactive blocks bring only their helpers', () => {
    expect(contentRuntime(new Set(['bar-chart', 'calendar', 'faq-list'])).helpers).toBe('');
    expect(contentRuntime(new Set(['lightbox'])).helpers).toContain('function VbGallery');
    expect(contentRuntime(new Set(['lottie'])).values).toEqual(['useState', 'useEffect', 'createElement']);
  });
});
