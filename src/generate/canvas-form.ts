/**
 * A Page Builder page's data contract: the form fields its inputs make, and
 * the API they are sent to.
 *
 * A page with at least one input becomes a real form. Every input gets a
 * field name (the element's own `field`, or one derived from its label), a
 * value kind (text, email, password, number, date, boolean), and the page
 * POSTs them as JSON to its own endpoint, `/api/<page>-api`. The backend and
 * database parts that receive them - a "<Page> API" route and a "<Page>
 * Store" table - are added to the project plan by the page sync job
 * (page-sync.ts), which generates their code from this same contract.
 *
 * Deterministic: which elements are fields, their names and kinds, and the
 * submit handler are all derived from the layout by fixed rules, never by a
 * model. A page with no inputs generates exactly as it did before.
 */
import { componentSlug, type PublicRoute } from './assemble.js';
import type { ValidatedProjectSchema } from '../types/project-schema.js';
import type { CanvasElement, CanvasElementType, PageLayout } from './canvas-layout.js';

export type FieldKind = 'text' | 'email' | 'password' | 'number' | 'date' | 'boolean' | 'list';

/** The element types that hold a value a person enters, and the kind of value each holds. */
export const FIELD_KINDS: Readonly<Partial<Record<CanvasElementType, FieldKind>>> = {
  input: 'text',
  textarea: 'text',
  select: 'text',
  search: 'text',
  email: 'email',
  password: 'password',
  number: 'number',
  slider: 'number',
  date: 'date',
  checkbox: 'boolean',
  radio: 'boolean',
  toggle: 'boolean',
  // form widgets (canvas-form-widgets.ts)
  'radio-group': 'text',
  segmented: 'text',
  time: 'text',
  'color-input': 'text',
  phone: 'text',
  url: 'text',
  otp: 'text',
  'tag-input': 'text',
  newsletter: 'email',
  signature: 'text',
  'rich-text': 'text',
  'checkbox-group': 'list',
  'multi-select': 'list',
  'date-range': 'date',
};

/** Widgets whose one element is several fields: a date range is `<name>From` and `<name>To`. */
const MULTI_FIELD_SUFFIXES: Readonly<Partial<Record<CanvasElementType, readonly string[]>>> = { 'date-range': ['From', 'To'] };

export interface FormField {
  readonly elementId: string;
  readonly name: string;
  readonly kind: FieldKind;
  /** The element's label, for the plan's plain-language description of the field. */
  readonly label: string;
}

export const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** "Full name" -> "fullName"; empty or symbol-only text -> null. */
function camelName(text: string): string | null {
  const words = text.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const joined = words.map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())).join('');
  const name = /^[A-Za-z]/.test(joined) ? joined : `field${joined}`;
  return name.slice(0, 40);
}

export function formFields(layout: PageLayout): readonly FormField[] {
  const used = new Set<string>();
  const fields: FormField[] = [];
  for (const element of layout.elements) {
    const kind = FIELD_KINDS[element.type];
    if (kind === undefined) continue;
    const base = element.field ?? camelName(element.label) ?? element.type;
    for (const suffix of MULTI_FIELD_SUFFIXES[element.type] ?? ['']) {
      const wanted = `${base}${suffix}`;
      let name = wanted;
      for (let n = 2; used.has(name); n += 1) name = `${wanted}${n}`;
      used.add(name);
      fields.push({ elementId: element.id, name, kind, label: element.label });
    }
  }
  return fields;
}

export function pageApiComponentName(pageName: string): string {
  return `${pageName.trim()} API`;
}

export function pageStoreComponentName(pageName: string): string {
  return `${pageName.trim()} Store`;
}

/** Where the page posts: the mount path assemble.ts gives the "<Page> API" backend component. */
export function pageApiPath(pageName: string): string {
  return `/api/${componentSlug(pageApiComponentName(pageName))}`;
}

/** Adds the field's name to the element's own form control - the first input/textarea/select tag in its markup. */
export function withFieldName(markup: string, name: string): string {
  return markup.replace(/<(input|textarea|select)(?=[\s>])/, `<$1 name="${name}"`);
}

/** In a form page the basic Button submits the form; content buttons (a card's, a hero's) stay plain buttons. */
export function asSubmitButton(element: CanvasElement, markup: string): string {
  return element.type === 'button' ? markup.replace('<button type="button"', '<button type="submit"') : markup;
}

function valueExpression(field: FormField): string {
  const raw = `data.get('${field.name}')`;
  if (field.kind === 'boolean') return `${raw} === 'on'`;
  if (field.kind === 'list') return `data.getAll('${field.name}').map(String)`;
  if (field.kind === 'number') return `Number(${raw} ?? 0)`;
  return `String(${raw} ?? '')`;
}

/** The component's submit handler: read every field, coerce it to its kind, POST it as JSON, report the outcome. */
export function submitHandlerSource(fields: readonly FormField[], apiPath: string): string {
  const body = fields.map((field) => `      ${field.name}: ${valueExpression(field)},`).join('\n');
  return [
    "  const [status, setStatus] = useState('');",
    '',
    '  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {',
    '    event.preventDefault();',
    '    const data = new FormData(event.currentTarget);',
    '    const body = {',
    body,
    '    };',
    "    setStatus('Sending…');",
    '    try {',
    `      const response = await fetch('${apiPath}', {`,
    "        method: 'POST',",
    "        headers: { 'content-type': 'application/json' },",
    '        body: JSON.stringify(body),',
    '      });',
    "      setStatus(response.ok ? 'Saved.' : `Could not save (${response.status}).`);",
    '    } catch {',
    "      setStatus('Could not reach the server.');",
    '    }',
    '  }',
    '',
  ].join('\n');
}

/** Plain-language field list for the plan's component purposes - what the model is told to accept and store. */
export function describeFields(fields: readonly FormField[]): string {
  return fields.map((field) => `${field.name} (${field.kind}${field.label.trim() === '' ? '' : `, "${field.label.trim()}"`})`).join(', ');
}

/** How a page-sync API's purpose begins - what marks a backend component as a page form's receiver. */
export const PAGE_FORM_API_PURPOSE_PREFIX = 'HTTP API behind the "';

/**
 * A page form is filled in by anyone who opens the page, so its POST is
 * public: the entry point lets it past the authentication middleware (rate
 * limiting and validation still apply). Listing submissions stays protected.
 */
export function publicRoutesFor(schema: ValidatedProjectSchema): readonly PublicRoute[] {
  return schema.domains.backend.components
    .filter((component) => component.purpose.startsWith(PAGE_FORM_API_PURPOSE_PREFIX))
    .map((component) => ({ method: 'POST', path: `/api/${componentSlug(component.name)}` }));
}
