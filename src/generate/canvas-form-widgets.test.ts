import { describe, expect, it } from 'vitest';
import { formFields } from './canvas-form.js';
import { layoutToComponentFile, type CanvasElement } from './canvas-layout.js';
import { formWidgetRuntime, withFieldNames } from './canvas-form-widgets.js';

const element = (type: CanvasElement['type'], label: string, extra: Partial<CanvasElement> = {}, id = 'el-1'): CanvasElement => ({
  id, type, x: 0, y: 0, width: 400, height: 80, label, colorToken: 'primary', ...extra,
});
const page = (elements: readonly CanvasElement[]) => ({ id: 'p', pageName: 'Signup', elements });

describe('form widgets', () => {
  it('a date range is two date fields, a checkbox group and a multi-select are lists', () => {
    const fields = formFields(page([
      element('date-range', 'From|To', { field: 'stay' }),
      element('checkbox-group', 'Pick|A|B', { field: 'picks' }, 'el-2'),
      element('multi-select', 'Tags|X|Y', { field: 'tags' }, 'el-3'),
    ]));
    expect(fields.map((f) => [f.name, f.kind])).toEqual([
      ['stayFrom', 'date'],
      ['stayTo', 'date'],
      ['picks', 'list'],
      ['tags', 'list'],
    ]);
  });

  it('submits lists with getAll and names every grouped input alike', () => {
    const code = layoutToComponentFile(page([element('checkbox-group', 'Pick|A|B', { field: 'picks' })])).contents;
    expect(code).toContain("picks: data.getAll('picks').map(String),");
    expect(code.match(/name="picks"/g)).toHaveLength(2);
    expect(code).not.toContain('__vbf');
  });

  it('fills placeholders in order', () => {
    expect(withFieldNames('<input name="__vbf0__" /><input name="__vbf1__" />', ['a', 'b'])).toBe('<input name="a" /><input name="b" />');
  });

  it('only the interactive widgets bring helpers and imports', () => {
    expect(formWidgetRuntime(new Set(['phone', 'otp', 'radio-group'])).helpers).toBe('');
    const signature = formWidgetRuntime(new Set(['signature']));
    expect(signature.values).toEqual(['useState', 'useRef']);
    expect(signature.types).toEqual(['PointerEvent']);
  });
});
