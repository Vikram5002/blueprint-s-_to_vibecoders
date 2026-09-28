import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { layoutToComponentFile, validatePageLayout, type CanvasElement, type PageLayout } from './canvas-layout.js';
import { HOVER_EFFECTS, MOTION_ELEMENT_TYPES, applyEffects } from './canvas-motion.js';

const element = (overrides: Partial<CanvasElement> & Pick<CanvasElement, 'type'>): CanvasElement => ({
  id: 'el-1', x: 0, y: 0, width: 400, height: 60, label: 'Hello world', colorToken: 'primary', ...overrides,
});
const page = (elements: readonly CanvasElement[]): PageLayout => ({ id: 'p', pageName: 'Home', elements });
const source = (elements: readonly CanvasElement[]): string => layoutToComponentFile(page(elements)).contents;

function syntaxErrors(code: string): readonly string[] {
  const result = ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 }, fileName: 'p.tsx' });
  return (result.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('motion elements', () => {
  it('every motion element, with every hover effect and reveal, is valid TSX', () => {
    const elements = [
      ...MOTION_ELEMENT_TYPES.map((type, i) => element({ id: `m-${i}`, type, label: type === 'counter' ? '12500|+|Customers' : 'One|Two|Three' })),
      ...HOVER_EFFECTS.map((hover, i) => element({ id: `h-${i}`, type: 'card', label: 'Card|Body|Go', hover, reveal: i % 2 === 0 })),
    ];
    expect(syntaxErrors(source(elements))).toEqual([]);
  });

  it('emits only the helpers and imports a page uses', () => {
    const counterOnly = source([element({ type: 'counter', label: '500|+|Users' })]);
    expect(counterOnly).toContain("import { useEffect, useState, type FC } from 'react';");
    expect(counterOnly).toContain('function VbCounter');
    expect(counterOnly).not.toContain('function VbTypewriter');
    expect(counterOnly).toContain('<VbCounter to={500} />+');
  });

  it('a shimmer needs CSS only - no React hooks', () => {
    const shimmer = source([element({ type: 'text-shimmer' })]);
    expect(shimmer.startsWith("import type { FC } from 'react';")).toBe(true);
    expect(shimmer).toContain('@keyframes vb-shimmer');
  });

  it('reveal-on-scroll adds the observer hook and the class', () => {
    const revealed = source([element({ type: 'heading', reveal: true })]);
    expect(revealed).toContain('new IntersectionObserver(');
    expect(revealed).toContain('className="vb-reveal"');
  });

  it('tilt wires mouse handlers with a typed event', () => {
    const tilted = source([element({ type: 'card', label: 'A|B|C', hover: 'tilt' })]);
    expect(tilted).toContain('type MouseEvent');
    expect(tilted).toContain('onMouseMove={vbTilt} onMouseLeave={vbReset}');
    expect(tilted).toContain('function vbReset');
  });

  it('rejects an unknown hover effect', () => {
    expect(validatePageLayout(page([element({ type: 'card', hover: 'wobble' as never })]))).toEqual([
      { reason: 'unknown-hover-effect', elementId: 'el-1', hover: 'wobble' },
    ]);
  });
});

describe('applyEffects', () => {
  it('merges into an existing className instead of adding a second one', () => {
    expect(applyEffects('<div className="vb-gradient-border" data-testid="x">', 'lift', true)).toBe('<div className="vb-gradient-border vb-hover-lift vb-reveal" data-testid="x">');
  });

  it('leaves markup alone when there is nothing to add', () => {
    expect(applyEffects('<span data-testid="x">', undefined, false)).toBe('<span data-testid="x">');
  });
});
