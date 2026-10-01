import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { formFields, pageApiPath, pageApiComponentName, pageStoreComponentName } from './canvas-form.js';
import { layoutToComponentFile, validatePageLayout, type CanvasElement, type PageLayout } from './canvas-layout.js';

function element(overrides: Partial<CanvasElement> & Pick<CanvasElement, 'type'>): CanvasElement {
  return { id: 'el-1', x: 10, y: 10, width: 200, height: 40, label: 'Content', colorToken: 'primary', ...overrides };
}

function page(elements: readonly CanvasElement[], pageName = 'Sign Up'): PageLayout {
  return { id: 'p', pageName, elements };
}

const signUp = page([
  element({ id: 'el-1', type: 'heading', label: 'Create your account' }),
  element({ id: 'el-2', type: 'input', label: 'Full name' }),
  element({ id: 'el-3', type: 'email', label: 'you@example.com', field: 'email' }),
  element({ id: 'el-4', type: 'password', label: 'Password' }),
  element({ id: 'el-5', type: 'number', label: 'Age' }),
  element({ id: 'el-6', type: 'toggle', label: 'Send me news' }),
  element({ id: 'el-7', type: 'button', label: 'Sign up' }),
  element({ id: 'el-8', type: 'card', label: 'Why join|Because|Learn more' }),
]);

function syntaxErrors(source: string): readonly string[] {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
    fileName: 'page.tsx',
  });
  return (result.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('formFields', () => {
  it('turns every input into a named, typed field, in canvas order', () => {
    expect(formFields(signUp).map((f) => [f.name, f.kind])).toEqual([
      ['fullName', 'text'],
      ['email', 'email'],
      ['password', 'password'],
      ['age', 'number'],
      ['sendMeNews', 'boolean'],
    ]);
  });

  it('keeps derived names unique', () => {
    const twins = page([element({ id: 'a', type: 'input', label: 'Name' }), element({ id: 'b', type: 'input', label: 'Name' })]);
    expect(formFields(twins).map((f) => f.name)).toEqual(['name', 'name2']);
  });

  it('names the API and store after the page, matching the backend mount path', () => {
    expect(pageApiComponentName('Sign Up')).toBe('Sign Up API');
    expect(pageStoreComponentName('Sign Up')).toBe('Sign Up Store');
    expect(pageApiPath('Sign Up')).toBe('/api/sign-up-api');
  });
});

describe('a page with inputs', () => {
  const source = layoutToComponentFile(signUp).contents;

  it('is a real form that posts its fields as JSON to the page API', () => {
    expect(source).toContain('<form onSubmit=');
    expect(source).toContain("fetch('/api/sign-up-api'");
    expect(source).toContain("fullName: String(data.get('fullName') ?? ''),");
    expect(source).toContain("age: Number(data.get('age') ?? 0),");
    expect(source).toContain("sendMeNews: data.get('sendMeNews') === 'on',");
    expect(source).toContain('role="status"');
  });

  it('names each input and makes only the Button submit', () => {
    expect(source).toContain('<input name="fullName" type="text"');
    expect(source).toContain('<input name="email" type="email"');
    expect(source).toContain('<input name="sendMeNews" type="checkbox" role="switch"');
    expect(source).toContain('<button type="submit" data-testid="el-7"');
    expect(source).toContain('<button type="button" style={{ alignSelf');
  });

  it('is valid TSX', () => {
    expect(syntaxErrors(source)).toEqual([]);
  });

  it('leaves a page without inputs without a form - its only state is the fit-to-screen scale', () => {
    const plain = layoutToComponentFile(page([element({ type: 'heading', label: 'Hi' })])).contents;
    expect(plain).not.toContain('<form');
    expect(plain).not.toContain('handleSubmit');
    expect(plain.match(/useState\(/g)).toHaveLength(1);
    expect(plain.startsWith("import { useEffect, useState, type FC } from 'react';")).toBe(true);
  });
});

describe('field-name validation', () => {
  it('rejects a field name that is not an identifier, and a duplicate one', () => {
    const bad = page([
      element({ id: 'a', type: 'input', field: '1st name' }),
      element({ id: 'b', type: 'input', field: 'email' }),
      element({ id: 'c', type: 'email', field: 'email' }),
    ]);
    expect(validatePageLayout(bad)).toEqual([
      { reason: 'invalid-field-name', elementId: 'a', field: '1st name' },
      { reason: 'duplicate-field-name', elementId: 'c', field: 'email' },
    ]);
  });
});
