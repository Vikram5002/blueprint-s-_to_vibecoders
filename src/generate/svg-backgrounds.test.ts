import { describe, expect, it } from 'vitest';
import { BACKGROUND_KINDS, mix, parseBackgroundLabel, renderBackgroundSvg, type BackgroundSpec } from './svg-backgrounds.js';

const spec: BackgroundSpec = { id: 'el-1', width: 1280, height: 240, color: '#6d5dfc', background: '#ffffff', seed: 42, complexity: 6 };

/** djb2 - the UI copy's test checks the same fingerprints, so editor preview and generated page cannot drift apart. */
export function fingerprint(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}

describe('svg backgrounds', () => {
  it('is deterministic: the same seed always draws the same shape', () => {
    for (const kind of BACKGROUND_KINDS) {
      expect(renderBackgroundSvg(kind, spec, 'jsx')).toBe(renderBackgroundSvg(kind, spec, 'jsx'));
    }
  });

  it('a different seed draws a different shape', () => {
    for (const kind of BACKGROUND_KINDS) {
      expect(renderBackgroundSvg(kind, { ...spec, seed: 7 }, 'html')).not.toBe(renderBackgroundSvg(kind, spec, 'html'));
    }
  });

  it('uses JSX attribute names for the page and HTML names for the preview', () => {
    const jsx = renderBackgroundSvg('circles', spec, 'jsx');
    const html = renderBackgroundSvg('circles', spec, 'html');
    expect(jsx).toContain('fillOpacity=');
    expect(html).toContain('fill-opacity=');
    expect(renderBackgroundSvg('mesh-gradient', spec, 'jsx')).toContain('stopColor=');
  });

  it('scopes gradient ids to the element', () => {
    expect(renderBackgroundSvg('mesh-gradient', spec, 'html')).toContain('id="vb-el-1-g0"');
  });

  it('parses seed and complexity from the label, with safe defaults', () => {
    expect(parseBackgroundLabel('42|6')).toEqual({ seed: 42, complexity: 6 });
    expect(parseBackgroundLabel('7|99')).toEqual({ seed: 7, complexity: 10 });
    expect(parseBackgroundLabel('')).toEqual({ seed: 1, complexity: 5 });
  });

  it('mixes colours', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('matches the fingerprints the UI copy is tested against', () => {
    expect(BACKGROUND_KINDS.map((kind) => fingerprint(renderBackgroundSvg(kind, spec, 'html')))).toMatchSnapshot();
  });
});
