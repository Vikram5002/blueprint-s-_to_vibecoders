import { describe, expect, it } from 'vitest';
import { SINGLE_COLUMN_PRESET } from './layout-presets';
import type { LayoutRegion, LayoutSchema } from './layout-types';
import { BREAKPOINTS, GRID_COLUMNS } from './layout-types';

/**
 * The custom builder's output and the preset mock data must be the same
 * LayoutSchema shape — that's the whole point of having one type. This
 * test builds a custom layout by hand (the same shape CustomLayoutBuilder
 * produces at runtime) and checks it against a preset, both typed as
 * LayoutSchema. If either literal below stopped satisfying the interface,
 * this file would fail to compile before the assertions even ran.
 */
describe('LayoutSchema shape parity', () => {
  const handBuiltCustomRegions: readonly LayoutRegion[] = [
    { type: 'header', placement: { colStart: 1, colSpan: 12, row: 1 } },
    { type: 'content', placement: { colStart: 1, colSpan: 8, row: 2 } },
    { type: 'sidebar', placement: { colStart: 9, colSpan: 4, row: 2 } },
  ];

  const handBuiltCustomLayout: LayoutSchema = {
    id: 'hand-built-custom',
    name: 'Hand-built test layout',
    columns: GRID_COLUMNS,
    breakpoints: BREAKPOINTS,
    source: 'custom',
    regions: handBuiltCustomRegions,
  };

  it('type-checks a hand-built custom layout and a preset against the same interface', () => {
    const schemas: readonly LayoutSchema[] = [handBuiltCustomLayout, SINGLE_COLUMN_PRESET];

    for (const schema of schemas) {
      expect(schema.columns).toBe(GRID_COLUMNS);
      expect(schema.breakpoints).toEqual(BREAKPOINTS);
      expect(Array.isArray(schema.regions)).toBe(true);
      for (const region of schema.regions) {
        expect(region.placement.colStart).toBeGreaterThanOrEqual(1);
        expect(region.placement.colSpan).toBeGreaterThanOrEqual(1);
        expect(region.placement.colStart + region.placement.colSpan - 1).toBeLessThanOrEqual(GRID_COLUMNS);
      }
    }
  });

  it('distinguishes source: custom vs ai-generated on the same shape', () => {
    expect(handBuiltCustomLayout.source).toBe('custom');
    expect(SINGLE_COLUMN_PRESET.source).toBe('ai-generated');
  });
});
