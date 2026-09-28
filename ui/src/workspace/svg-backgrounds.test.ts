import { describe, expect, it } from 'vitest';
import { BACKGROUND_KINDS, renderBackgroundSvg, type BackgroundSpec } from './svg-backgrounds';

const spec: BackgroundSpec = { id: 'el-1', width: 1280, height: 240, color: '#6d5dfc', background: '#ffffff', seed: 42, complexity: 6 };

function fingerprint(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}

describe('svg backgrounds (editor copy)', () => {
  it('draws exactly what the generator draws - same fingerprints as src/generate/svg-backgrounds.test.ts', () => {
    expect(BACKGROUND_KINDS.map((kind) => fingerprint(renderBackgroundSvg(kind, spec, 'html')))).toEqual([
      '4fc8f5a6',
      'a553d3cf',
      'c395cd00',
      '6f93f9c0',
      '42e27fbd',
      'c60f50b3',
      '659442fc',
    ]);
  });
});
