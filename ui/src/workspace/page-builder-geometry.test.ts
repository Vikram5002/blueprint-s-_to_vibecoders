import { describe, expect, it } from 'vitest';
import { clampToCanvas, reorder, resizeRect, snapMove } from './page-builder-geometry';
import type { CanvasElement } from './page-builder-types';

const el = (id: string): CanvasElement => ({ id, type: 'text', x: 0, y: 0, width: 10, height: 10, label: '', colorToken: 'primary' });

describe('snapMove', () => {
  it('snaps to the 8px grid when nothing is near', () => {
    expect(snapMove({ x: 203, y: 309, width: 100, height: 40 }, [])).toEqual({ x: 200, y: 312, guides: [] });
  });

  it("aligns a left edge with another element's left edge and reports the guide", () => {
    const other = { x: 400, y: 100, width: 200, height: 50 };
    const snapped = snapMove({ x: 404, y: 300, width: 100, height: 40 }, [other]);
    expect(snapped.x).toBe(400);
    expect(snapped.guides).toContainEqual({ axis: 'x', at: 400 });
  });

  it('centres on the canvas centre line', () => {
    const snapped = snapMove({ x: 588, y: 20, width: 100, height: 40 }, []);
    expect(snapped.x).toBe(590);
    expect(snapped.guides).toContainEqual({ axis: 'x', at: 640 });
  });

  it('never leaves the canvas', () => {
    expect(snapMove({ x: 1250, y: -30, width: 100, height: 40 }, [])).toMatchObject({ x: 1180, y: 0 });
  });
});

describe('resizeRect', () => {
  const start = { x: 100, y: 100, width: 200, height: 100 };

  it('grows from the south-east corner, grid-snapped', () => {
    expect(resizeRect(start, 'se', 45, 21)).toEqual({ x: 100, y: 100, width: 244, height: 124 });
  });

  it('keeps the right edge fixed when dragging the west handle', () => {
    expect(resizeRect(start, 'w', -37, 0)).toEqual({ x: 64, y: 100, width: 236, height: 100 });
  });

  it('never shrinks below the minimum size', () => {
    expect(resizeRect(start, 'e', -500, 0).width).toBe(8);
    expect(resizeRect(start, 'n', 0, 500).height).toBe(8);
  });

  it('stops at the canvas edges', () => {
    expect(resizeRect(start, 'nw', -500, -500)).toMatchObject({ x: 0, y: 0, width: 300, height: 200 });
    expect(resizeRect(start, 'se', 5000, 5000)).toMatchObject({ width: 1180, height: 700 });
  });
});

describe('clampToCanvas', () => {
  it('shrinks an oversize rect to the canvas', () => {
    expect(clampToCanvas({ x: -5, y: 10, width: 2000, height: 900 })).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  });
});

describe('reorder', () => {
  const list = [el('a'), el('b'), el('c')];
  const ids = (l: readonly CanvasElement[]): string[] => l.map((e) => e.id);
  it('moves forward, backward, to front and to back', () => {
    expect(ids(reorder(list, 'a', 'forward'))).toEqual(['b', 'a', 'c']);
    expect(ids(reorder(list, 'c', 'backward'))).toEqual(['a', 'c', 'b']);
    expect(ids(reorder(list, 'a', 'front'))).toEqual(['b', 'c', 'a']);
    expect(ids(reorder(list, 'c', 'back'))).toEqual(['c', 'a', 'b']);
  });
});
