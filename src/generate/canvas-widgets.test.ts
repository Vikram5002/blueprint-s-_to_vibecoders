import { describe, expect, it } from 'vitest';
import { layoutToComponentFile, type CanvasElement } from './canvas-layout.js';
import { WIDGET_TYPES, widgetRuntime } from './canvas-widgets.js';

const element = (type: CanvasElement['type'], label: string, id = 'el-1'): CanvasElement => ({ id, type, x: 0, y: 0, width: 400, height: 60, label, colorToken: 'primary' });
const source = (elements: readonly CanvasElement[]): string => layoutToComponentFile({ id: 'p', pageName: 'Home', elements }).contents;

describe('widgets', () => {
  it('only interactive widgets bring React helpers; the rest are CSS or plain markup', () => {
    expect(widgetRuntime(new Set(['tooltip', 'dropdown-menu', 'columns'])).values).toEqual([]);
    expect(widgetRuntime(new Set(['modal'])).values).toEqual(['useState']);
    expect(widgetRuntime(new Set(['cookie-banner'])).values).toEqual(['useEffect', 'useState']);
  });

  it('a modal page gets the modal helper and a state import, nothing else', () => {
    const code = source([element('modal', 'Open|Title|Body')]);
    expect(code).toContain("import { useState, type FC } from 'react';");
    expect(code).toContain('function VbModal(');
    expect(code).not.toContain('function VbCookieBanner(');
  });

  it('shared menu rules are emitted once when both menus are used', () => {
    const code = source([element('dropdown-menu', 'Menu|A'), element('mobile-menu', 'Brand|A', 'el-2')]);
    expect(code.split('.vb-menu > summary { list-style: none; cursor: pointer; }').length - 1).toBe(1);
  });

  it('every widget keeps its data-testid', () => {
    const code = source(WIDGET_TYPES.map((type, i) => element(type, 'A|B|C', `el-${i}`)));
    for (let i = 0; i < WIDGET_TYPES.length; i += 1) expect(code).toContain(`data-testid="el-${i}"`);
  });
});
