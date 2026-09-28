/**
 * Form widgets for the Page Builder: grouped choices, richer inputs, and the
 * interactive ones (tag input, signature pad, rich text) - every one of them
 * a real field of the page's form (canvas-form.ts), so it submits with the
 * page and can be synced to the backend.
 *
 * Inputs carry name placeholders (`__vbf0__`, `__vbf1__`) that the page
 * template replaces with the element's field names: a group's inputs all
 * share `__vbf0__` (one field), a date range uses `__vbf0__`/`__vbf1__`
 * (two fields, `<name>From` and `<name>To`).
 */
import type { ElementContext } from './canvas-elements.js';

export const FORM_WIDGET_TYPES = [
  'radio-group', 'checkbox-group', 'segmented', 'time', 'date-range', 'color-input', 'phone', 'url',
  'multi-select', 'tag-input', 'otp', 'newsletter', 'signature', 'rich-text',
] as const;
export type FormWidgetType = (typeof FORM_WIDGET_TYPES)[number];

const F0 = '__vbf0__';
const F1 = '__vbf1__';

function parts(label: string): string[] {
  return label.split('|').map((part) => part.trim()).filter((part) => part !== '');
}

function head(tag: string, c: ElementContext, style: string, extra = ''): string {
  return `<${tag}${extra} data-testid="${c.id}" style={{ ${c.position}, boxSizing: 'border-box', ${style} }}>`;
}

/** Input look without a height: positioned inputs take theirs from the canvas. */
const inputStyle = (c: ElementContext): string =>
  `border: '1px solid ${c.line}', borderRadius: 8, padding: '0 12px', fontSize: 14, color: '${c.ink}', backgroundColor: '${c.surface}', boxSizing: 'border-box'`;

function typed(type: string, extraAttrs = ''): (c: ElementContext) => string {
  return (c) =>
    `<input type="${type}" name="${F0}"${extraAttrs} data-testid="${c.id}" placeholder="${c.attr(c.label)}" aria-label="${c.attr(c.label)}" style={{ ${c.position}, ${inputStyle(c)} }} />`;
}

function choiceGroup(kind: 'radio' | 'checkbox'): (c: ElementContext) => string {
  return (c) => {
    const [legend = 'Choose', ...options] = parts(c.label);
    const items = options
      .map((option) => `<label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: '${c.ink}' }}><input type="${kind}" name="${F0}" value="${c.attr(option)}" style={{ accentColor: '${c.color}' }} />${c.text(option)}</label>`)
      .join('');
    return `${head('fieldset', c, `margin: 0, border: '1px solid ${c.line}', borderRadius: 10, padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 6`)}<legend style={{ fontSize: 13, fontWeight: 600, color: '${c.muted}', padding: '0 4px' }}>${c.text(legend)}</legend>${items}</fieldset>`;
  };
}

function segmented(c: ElementContext): string {
  const options = parts(c.label);
  const items = options
    .map((option, i) => `<label><input type="radio" name="${F0}" value="${c.attr(option)}"${i === 0 ? ' defaultChecked' : ''} /><span>${c.text(option)}</span></label>`)
    .join('');
  // The accent is a CSS variable, so :checked can use it; the cast is what lets a custom property into a style object.
  return `<div className="vb-seg" role="radiogroup" data-testid="${c.id}" style={{ ${c.position}, boxSizing: 'border-box', display: 'flex', padding: 4, gap: 4, borderRadius: 10, backgroundColor: '${c.line}', '--vb-accent': '${c.color}' } as CSSProperties}>${items}</div>`;
}

function dateRange(c: ElementContext): string {
  const [from = 'From', to = 'To'] = parts(c.label);
  const box = (name: string, label: string): string =>
    `<label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '${c.muted}' }}>${c.text(label)}<input type="date" name="${name}" style={{ height: 40, ${inputStyle(c)} }} /></label>`;
  return `${head('div', c, `display: 'flex', gap: 12, alignItems: 'flex-end'`)}${box(F0, from)}${box(F1, to)}</div>`;
}

function colorInput(c: ElementContext): string {
  return `${head('label', c, `display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: '${c.ink}'`)}<input type="color" name="${F0}" defaultValue="${c.color}" style={{ width: 44, height: 36, border: 'none', background: 'none', padding: 0 }} />${c.text(c.label)}</label>`;
}

function multiSelect(c: ElementContext): string {
  const [prompt = 'Choose', ...options] = parts(c.label);
  const items = options.map((option) => `<option value="${c.attr(option)}">${c.text(option)}</option>`).join('');
  return `<select multiple name="${F0}" data-testid="${c.id}" aria-label="${c.attr(prompt)}" style={{ ${c.position}, border: '1px solid ${c.line}', borderRadius: 8, padding: 6, fontSize: 14, color: '${c.ink}', backgroundColor: '${c.surface}', boxSizing: 'border-box' }}>${items}</select>`;
}

function tagInput(c: ElementContext): string {
  return `${head('div', c, `display: 'flex'`)}<VbTagInput name="${F0}" placeholder={${JSON.stringify(c.label)}} color="${c.color}" line="${c.line}" surface="${c.surface}" ink="${c.ink}" /></div>`;
}

function otp(c: ElementContext): string {
  return `<input name="${F0}" data-testid="${c.id}" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" placeholder="000000" aria-label="${c.attr(c.label || 'Verification code')}" style={{ ${c.position}, border: '1px solid ${c.line}', borderRadius: 10, textAlign: 'center', fontSize: 26, letterSpacing: '0.6em', paddingLeft: '0.6em', fontFamily: 'ui-monospace, monospace', color: '${c.ink}', backgroundColor: '${c.surface}', boxSizing: 'border-box' }} />`;
}

function newsletter(c: ElementContext): string {
  const [title = 'Get the newsletter', placeholder = 'you@example.com', action = 'Subscribe'] = parts(c.label);
  return `${head('div', c, `display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'center'`)}<strong style={{ fontSize: 18, color: '${c.ink}' }}>${c.text(title)}</strong><div style={{ display: 'flex', gap: 8 }}><input type="email" name="${F0}" placeholder="${c.attr(placeholder)}" aria-label="${c.attr(placeholder)}" style={{ flex: 1, height: 42, ${inputStyle(c)} }} /><button type="submit" style={{ backgroundColor: '${c.color}', color: '#ffffff', border: 'none', borderRadius: 8, padding: '0 18px', cursor: 'pointer' }}>${c.text(action)}</button></div></div>`;
}

function signature(c: ElementContext): string {
  return `${head('div', c, `display: 'flex'`)}<VbSignature name="${F0}" color="${c.color}" line="${c.line}" surface="${c.surface}" muted="${c.muted}" label={${JSON.stringify(c.label || 'Sign here')}} /></div>`;
}

function richText(c: ElementContext): string {
  return `${head('div', c, `display: 'flex'`)}<VbRichText name="${F0}" placeholder={${JSON.stringify(c.label)}} color="${c.color}" line="${c.line}" surface="${c.surface}" ink="${c.ink}" /></div>`;
}

export const FORM_WIDGET_RENDERERS: Readonly<Record<FormWidgetType, (c: ElementContext) => string>> = {
  'radio-group': choiceGroup('radio'),
  'checkbox-group': choiceGroup('checkbox'),
  segmented,
  time: typed('time'),
  'date-range': dateRange,
  'color-input': colorInput,
  phone: typed('tel', ' autoComplete="tel"'),
  url: typed('url'),
  'multi-select': multiSelect,
  'tag-input': tagInput,
  otp,
  newsletter,
  signature,
  'rich-text': richText,
};

/** Replaces an element's field-name placeholders with its real field names, in order. */
export function withFieldNames(markup: string, names: readonly string[]): string {
  return markup.replace(/__vbf(\d)__/g, (_match, index: string) => names[Number(index)] ?? names[0] ?? 'field');
}

// ---- runtime --------------------------------------------------------------------

const HELPERS: Readonly<Partial<Record<FormWidgetType, readonly string[]>>> = {
  'tag-input': [
    'function VbTagInput(props: { readonly name: string; readonly placeholder: string; readonly color: string; readonly line: string; readonly surface: string; readonly ink: string }) {',
    '  const [tags, setTags] = useState<string[]>([]);',
    "  const [draft, setDraft] = useState('');",
    '  const add = () => {',
    '    const tag = draft.trim();',
    '    if (tag !== \'\' && !tags.includes(tag)) setTags([...tags, tag]);',
    "    setDraft('');",
    '  };',
    '  return (',
    "    <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: 6, border: `1px solid ${props.line}`, borderRadius: 8, backgroundColor: props.surface }}>",
    '      {tags.map((tag) => (',
    "        <span key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999, backgroundColor: props.color, color: '#ffffff', fontSize: 13 }}>",
    '          {tag}',
    "          <button type=\"button\" aria-label={`Remove ${tag}`} onClick={() => setTags(tags.filter((t) => t !== tag))} style={{ border: 'none', background: 'none', color: '#ffffff', cursor: 'pointer', padding: 0 }}>×</button>",
    '        </span>',
    '      ))}',
    "      <input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(); } }} onBlur={add} placeholder={props.placeholder} style={{ flex: 1, minWidth: 80, border: 'none', outline: 'none', background: 'transparent', color: props.ink, fontSize: 14 }} />",
    "      <input type=\"hidden\" name={props.name} value={tags.join(',')} />",
    '    </div>',
    '  );',
    '}',
  ],
  signature: [
    'function VbSignature(props: { readonly name: string; readonly color: string; readonly line: string; readonly surface: string; readonly muted: string; readonly label: string }) {',
    '  const canvas = useRef<HTMLCanvasElement | null>(null);',
    '  const drawing = useRef(false);',
    "  const [value, setValue] = useState('');",
    '  const point = (event: PointerEvent<HTMLCanvasElement>) => {',
    '    const rect = event.currentTarget.getBoundingClientRect();',
    '    return { x: ((event.clientX - rect.left) / rect.width) * event.currentTarget.width, y: ((event.clientY - rect.top) / rect.height) * event.currentTarget.height };',
    '  };',
    '  const context = () => {',
    "    const ctx = canvas.current?.getContext('2d') ?? null;",
    '    if (ctx !== null) { ctx.strokeStyle = props.color; ctx.lineWidth = 2.5; ctx.lineCap = \'round\'; }',
    '    return ctx;',
    '  };',
    '  return (',
    "    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>",
    '      <canvas',
    '        ref={canvas}',
    '        width={600}',
    '        height={200}',
    '        aria-label={props.label}',
    "        style={{ flex: 1, width: '100%', minHeight: 0, border: `1px dashed ${props.line}`, borderRadius: 10, backgroundColor: props.surface, touchAction: 'none', cursor: 'crosshair' }}",
    '        onPointerDown={(event) => { drawing.current = true; const p = point(event); const ctx = context(); ctx?.beginPath(); ctx?.moveTo(p.x, p.y); }}',
    '        onPointerMove={(event) => { if (!drawing.current) return; const p = point(event); const ctx = context(); ctx?.lineTo(p.x, p.y); ctx?.stroke(); }}',
    "        onPointerUp={() => { drawing.current = false; setValue(canvas.current?.toDataURL('image/png') ?? ''); }}",
    '      />',
    "      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: props.muted }}>",
    '        <span>{props.label}</span>',
    "        <button type=\"button\" onClick={() => { const c = canvas.current; c?.getContext('2d')?.clearRect(0, 0, c.width, c.height); setValue(''); }} style={{ border: 'none', background: 'none', color: props.color, cursor: 'pointer' }}>Clear</button>",
    '      </div>',
    '      <input type="hidden" name={props.name} value={value} />',
    '    </div>',
    '  );',
    '}',
  ],
  'rich-text': [
    'function VbRichText(props: { readonly name: string; readonly placeholder: string; readonly color: string; readonly line: string; readonly surface: string; readonly ink: string }) {',
    "  const [html, setHtml] = useState('');",
    '  const format = (command: string) => document.execCommand(command);',
    "  const button = { border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, padding: '4px 8px', color: props.ink } as const;",
    '  return (',
    "    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', border: `1px solid ${props.line}`, borderRadius: 10, backgroundColor: props.surface, overflow: 'hidden' }}>",
    "      <div style={{ display: 'flex', gap: 2, borderBottom: `1px solid ${props.line}`, padding: 4 }}>",
    "        <button type=\"button\" onMouseDown={(event) => { event.preventDefault(); format('bold'); }} style={{ ...button, fontWeight: 700 }}>B</button>",
    "        <button type=\"button\" onMouseDown={(event) => { event.preventDefault(); format('italic'); }} style={{ ...button, fontStyle: 'italic' }}>I</button>",
    "        <button type=\"button\" onMouseDown={(event) => { event.preventDefault(); format('insertUnorderedList'); }} style={button}>• List</button>",
    '      </div>',
    "      <div contentEditable suppressContentEditableWarning data-placeholder={props.placeholder} className=\"vb-rich\" onInput={(event) => setHtml(event.currentTarget.innerHTML)} style={{ flex: 1, padding: 12, outline: 'none', color: props.ink, fontSize: 14, lineHeight: 1.5, overflowY: 'auto' }} />",
    '      <input type="hidden" name={props.name} value={html} />',
    '    </div>',
    '  );',
    '}',
  ],
};

const CSS: Readonly<Partial<Record<FormWidgetType, readonly string[]>>> = {
  segmented: [
    '.vb-seg label { flex: 1; display: flex; }',
    '.vb-seg input { position: absolute; opacity: 0; pointer-events: none; }',
    '.vb-seg span { flex: 1; display: flex; align-items: center; justify-content: center; border-radius: 8px; font-size: 14px; cursor: pointer; transition: background 150ms, color 150ms; }',
    '.vb-seg input:checked + span { background: var(--vb-accent); color: #ffffff; }',
  ],
  'rich-text': ['.vb-rich:empty::before { content: attr(data-placeholder); opacity: 0.5; }'],
};

export interface FormWidgetRuntime {
  readonly values: readonly string[];
  readonly types: readonly string[];
  readonly helpers: string;
  readonly css: readonly string[];
}

export function formWidgetRuntime(types: ReadonlySet<string>): FormWidgetRuntime {
  const used = FORM_WIDGET_TYPES.filter((type) => types.has(type));
  const helpers = used.flatMap((type) => (HELPERS[type] === undefined ? [] : [(HELPERS[type] ?? []).join('\n')]));
  return {
    values: [...(helpers.length > 0 ? ['useState'] : []), ...(used.includes('signature') ? ['useRef'] : [])],
    types: [...(used.includes('signature') ? ['PointerEvent'] : []), ...(used.includes('segmented') ? ['CSSProperties'] : [])],
    helpers: helpers.join('\n\n'),
    css: used.flatMap((type) => CSS[type] ?? []),
  };
}
