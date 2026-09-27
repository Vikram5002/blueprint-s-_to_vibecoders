import { describe, expect, it } from 'vitest';
import { SECTION_TEMPLATES, instantiateTemplate, templateTop } from './page-templates';
import { CANVAS_ELEMENT_TYPES, CANVAS_HEIGHT, CANVAS_WIDTH } from './page-builder-types';

describe('section templates', () => {
  it('every part is a real element type and fits inside its section and the canvas', () => {
    for (const template of SECTION_TEMPLATES) {
      for (const part of template.parts) {
        expect(CANVAS_ELEMENT_TYPES).toContain(part.type);
        expect(part.x).toBeGreaterThanOrEqual(0);
        expect(part.x + part.width).toBeLessThanOrEqual(CANVAS_WIDTH);
        expect(part.y + part.height).toBeLessThanOrEqual(template.height);
      }
      expect(template.height).toBeLessThanOrEqual(CANVAS_HEIGHT);
    }
  });

  it('places a template below existing content with fresh, sequential ids', () => {
    const login = SECTION_TEMPLATES.find((t) => t.id === 'login');
    if (login === undefined) throw new Error('missing');
    const existing = [{ id: 'el-1', type: 'heading' as const, x: 0, y: 0, width: 100, height: 40, label: '', colorToken: 'primary' as const }];
    const placed = instantiateTemplate(login, templateTop(existing), 2, CANVAS_HEIGHT);
    expect(placed?.[0]?.id).toBe('el-2');
    expect(placed?.[0]?.y).toBe(56 + 20);
  });

  it('moves a template up so it still fits when the canvas is nearly full', () => {
    const faq = SECTION_TEMPLATES.find((t) => t.id === 'faq');
    if (faq === undefined) throw new Error('missing');
    const placed = instantiateTemplate(faq, 700, 1, CANVAS_HEIGHT);
    expect(Math.max(...(placed ?? []).map((e) => e.y + e.height))).toBeLessThanOrEqual(CANVAS_HEIGHT);
  });
});
