import { describe, expect, it } from 'vitest';
import { ELEMENT_CATEGORIES, ELEMENT_SPECS, labelParts } from './page-builder-catalogue';
import { CANVAS_ELEMENT_TYPES, CANVAS_HEIGHT, CANVAS_WIDTH } from './page-builder-types';

describe('page-builder catalogue', () => {
  it('puts every element type in exactly one palette category', () => {
    const listed = ELEMENT_CATEGORIES.flatMap((category) => category.types);
    expect([...listed].sort()).toEqual([...CANVAS_ELEMENT_TYPES].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('gives every element a default size that fits on the canvas', () => {
    for (const type of CANVAS_ELEMENT_TYPES) {
      const spec = ELEMENT_SPECS[type];
      expect(spec.width).toBeGreaterThan(0);
      expect(spec.height).toBeGreaterThan(0);
      expect(spec.width).toBeLessThanOrEqual(CANVAS_WIDTH);
      expect(spec.height).toBeLessThanOrEqual(CANVAS_HEIGHT);
    }
  });

  it('splits labels on | and drops empty parts', () => {
    expect(labelParts('Brand| Home ||Pricing')).toEqual(['Brand', 'Home', 'Pricing']);
  });
});
