/**
 * The page put in when the repair coder could not make a data page work. Found live (2026-10-28,
 * hotel app): three repair rounds rewrote the Rooms page with hardcoded rooms each time, so the
 * finished app could never show a room. This page is fixed text, not model output: it lists the
 * records of the route named for the page and offers a labelled input for every field its POST
 * reads - plain, but it works against the real API for any app, trained-on or not.
 */
import type { Component } from '../types/project-schema.js';
import { componentSlug, componentTargetPath, pascalIdentifier, type GeneratedFile } from './assemble.js';
import { GENERIC_PAGE_WORDS, pathWords, sampleValue, type ApiRoute } from './form-check.js';

/** The list route (GET, no `:param`) sharing the most words with the page name; ties go to the first. */
export function routeForPage(name: string, routes: readonly ApiRoute[]): ApiRoute | undefined {
  const words = [...pathWords(name)].filter((w) => !GENERIC_PAGE_WORDS.has(w));
  let best: { route: ApiRoute; score: number } | undefined;
  for (const route of routes) {
    if (route.method !== 'GET' || route.path.includes(':')) continue;
    const offered = pathWords(route.path.split('/').slice(3).join('/'));
    const score = words.filter((w) => offered.has(w)).length;
    if (score > 0 && (best === undefined || score > best.score)) best = { route, score };
  }
  return best?.route;
}

const inputType = (field: string): string => {
  const sample = sampleValue(field);
  if (typeof sample === 'number') return 'number';
  if (typeof sample === 'boolean') return 'checkbox';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(sample))) return 'date';
  if (String(sample).includes('@')) return 'email';
  return 'text';
};

/** The standard page for `component`, or null when no list route is named for it. */
export function fallbackDataPage(component: Component, routes: readonly ApiRoute[]): GeneratedFile | null {
  const list = routeForPage(component.name, routes);
  if (list === undefined) return null;
  const create = routes.find((r) => r.method === 'POST' && r.path === list.path);
  const fields = create?.fields ?? [];
  const slug = componentSlug(component.name);
  const types = Object.fromEntries(fields.map((f) => [f, inputType(f)]));
  const lines = [
    "import { useEffect, useState, type FormEvent } from 'react';",
    '',
    '// Written by VibeCoder after the model could not make this page work: it shows and adds real records.',
    `const FIELDS: ReadonlyArray<{ name: string; type: string }> = ${JSON.stringify(fields.map((f) => ({ name: f, type: types[f] })))};`,
    '',
    `export function ${pascalIdentifier(slug)}() {`,
    '  const [items, setItems] = useState<Record<string, unknown>[]>([]);',
    "  const [message, setMessage] = useState('');",
    '  const [form, setForm] = useState<Record<string, string | boolean>>({});',
    '',
    '  const load = (): void => {',
    `    fetch(${JSON.stringify(list.path)})`,
    '      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))',
    '      .then((d: unknown) => setItems(Array.isArray(d) ? (d as Record<string, unknown>[]) : []))',
    '      .catch((e: unknown) => setMessage(String(e)));',
    '  };',
    '  useEffect(load, []);',
    '',
    '  const submit = async (event: FormEvent): Promise<void> => {',
    '    event.preventDefault();',
    '    const value = (name: string): string | number | boolean => {',
    '      const f = FIELDS.find((x) => x.name === name);',
    "      const v = form[name] ?? (f?.type === 'checkbox' ? false : '');",
    "      return f?.type === 'number' ? Number(v) : v;",
    '    };',
    // Field names written out, so the form check reads this page like any other.
    `    const r = await fetch(${JSON.stringify(list.path)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ${fields.map((f) => `${/^[A-Za-z_$][\w$]*$/.test(f) ? f : JSON.stringify(f)}: value(${JSON.stringify(f)})`).join(', ')} }) });`,
    "    setMessage(r.ok ? 'Saved.' : `Not saved: HTTP ${r.status}`);",
    '    if (r.ok) { setForm({}); load(); }',
    '  };',
    '',
    '  const columns = [...new Set(items.flatMap((item) => Object.keys(item)))];',
    '  return (',
    '    <section>',
    `      <h1>${component.name.replace(/[<>{}]/g, '')}</h1>`,
    '      {message !== \'\' && <p role="status">{message}</p>}',
    '      {FIELDS.length > 0 && (',
    '        <form onSubmit={(e) => { void submit(e); }}>',
    // Destructured, so the form check does not read `f.name` as a field shown for each record.
    '          {FIELDS.map(({ name, type }) => (',
    '            <label key={name} style={{ display: \'block\', margin: \'8px 0\' }}>',
    '              {name}{\' \'}',
    "              {type === 'checkbox'",
    '                ? <input type="checkbox" name={name} checked={form[name] === true} onChange={(e) => setForm({ ...form, [name]: e.target.checked })} />',
    "                : <input type={type} name={name} required value={String(form[name] ?? '')} onChange={(e) => setForm({ ...form, [name]: e.target.value })} />}",
    '            </label>',
    '          ))}',
    '          <button type="submit">Save</button>',
    '        </form>',
    '      )}',
    '      {items.length === 0 ? <p>No records yet.</p> : (',
    '        <table>',
    '          <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>',
    '          <tbody>',
    '            {items.map((item, i) => (',
    "              <tr key={i}>{columns.map((c) => <td key={c}>{String(item[c] ?? '')}</td>)}</tr>",
    '            ))}',
    '          </tbody>',
    '        </table>',
    '      )}',
    '    </section>',
    '  );',
    '}',
    '',
  ];
  return { path: componentTargetPath('frontend', component), contents: lines.join('\n') };
}
