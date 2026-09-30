import { describe, expect, it } from 'vitest';
import { applyDesignOperations } from './page-designer';
import type { CanvasElement } from './page-builder-types';

const button: CanvasElement = {
  id: 'el-3',
  type: 'button',
  x: 10,
  y: 10,
  width: 160,
  height: 40,
  label: 'Go',
  colorToken: 'primary',
  animation: 'fade-in',
};

describe('applyDesignOperations', () => {
  it('adds with fresh el-N ids after the highest in use, keeping what is already there', () => {
    const { elements, changed } = applyDesignOperations(
      [button],
      [
        {
          op: 'add',
          type: 'heading',
          x: 0,
          y: 0,
          width: 300,
          height: 50,
          label: 'Hi',
          colorToken: 'dark',
        },
        {
          op: 'add',
          type: 'text',
          x: 0,
          y: 60,
          width: 300,
          height: 30,
          label: 'Sub',
          colorToken: 'neutral',
        },
      ],
    );
    expect(changed).toBe(2);
    expect(elements.map((element) => element.id)).toEqual(['el-3', 'el-4', 'el-5']);
  });

  it('updates only the given fields, and can clear an animation', () => {
    const { elements } = applyDesignOperations(
      [button],
      [{ op: 'update', id: 'el-3', label: 'Join', animation: null }],
    );
    expect(elements[0]).toEqual({
      id: 'el-3',
      type: 'button',
      x: 10,
      y: 10,
      width: 160,
      height: 40,
      label: 'Join',
      colorToken: 'primary',
    });
  });

  it('skips operations on elements removed in the meantime - edits made by hand are kept', () => {
    const { elements, changed } = applyDesignOperations(
      [],
      [
        { op: 'update', id: 'el-3', label: 'x' },
        { op: 'remove', id: 'el-3' },
      ],
    );
    expect(elements).toEqual([]);
    expect(changed).toBe(0);
  });

  it('removes an element that exists', () => {
    expect(applyDesignOperations([button], [{ op: 'remove', id: 'el-3' }])).toEqual({
      elements: [],
      changed: 1,
    });
  });
});
