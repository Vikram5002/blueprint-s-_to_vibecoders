/**
 * Turns a model-written React page into a Page Builder `PageLayout` so the
 * page can be opened, edited and re-saved on the canvas.
 *
 * Deterministic and text-based, in the spirit of `extractNamedExports`
 * (component-codegen.ts): it scans the JSX for the elements the canvas has
 * an equivalent for - headings, paragraphs, buttons, links, images, form
 * controls, dividers - and stacks them top to bottom in reading order,
 * flowing into a second column when the fixed canvas fills up. Layout in
 * the source (flex, grid, CSS) is not interpreted: the result is an honest
 * inventory of the page's visible pieces laid out plainly, which is what a
 * person then arranges. Nothing is inferred by a model.
 *
 * Dynamic text (`{product.name}`) becomes a readable placeholder derived
 * from the expression's last identifier ("Name"), so a list page still
 * shows one representative row rather than an empty canvas.
 */
import { CANVAS_HEIGHT, CANVAS_WIDTH, type CanvasElement, type CanvasElementType, type PageLayout } from './canvas-layout.js';

const COLUMN_WIDTH = 560;
const COLUMN_GAP = 40;
const MARGIN = 40;
const ROW_GAP = 16;

const HEIGHT: Readonly<Record<CanvasElementType, number>> = {
  heading: 56,
  text: 48,
  button: 44,
  link: 32,
  image: 180,
  input: 40,
  textarea: 96,
  checkbox: 32,
  radio: 32,
  select: 40,
  divider: 8,
  container: 120,
};

const WIDTH: Readonly<Record<CanvasElementType, number>> = {
  heading: COLUMN_WIDTH,
  text: COLUMN_WIDTH,
  button: 200,
  link: 240,
  image: 320,
  input: 360,
  textarea: COLUMN_WIDTH,
  checkbox: 260,
  radio: 260,
  select: 300,
  divider: COLUMN_WIDTH,
  container: COLUMN_WIDTH,
};

interface Found {
  readonly index: number;
  readonly type: CanvasElementType;
  readonly label: string;
}

/** Matches an opening tag of interest and, for text-bearing tags, its inner text up to the closing tag. */
const TAG_PATTERN =
  /<(h[1-6]|p|button|a|label|img|input|textarea|select|hr)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;

/**
 * Blanks every `{...}` attribute expression (balanced, so `onClick={() =>
 * f('x')}` and `style={{ a: 1 }}` both go) before tag matching: a `>` inside
 * an arrow function otherwise ends the opening tag early and its remainder
 * leaks into the element's text. Text-position `{expr}` placeholders are
 * handled separately by `visibleText`, so only expressions preceded by `=`
 * are blanked here.
 */
function blankAttributeExpressions(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    if (source[i] === '=' && source[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < source.length; j += 1) {
        if (source[j] === '{') depth += 1;
        else if (source[j] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      // A readable expression (`alt={product.name}`) keeps its placeholder so
      // `attribute()` still sees it; a handler or style object becomes "".
      out += `="${placeholderFor(source.slice(i + 2, j)).replace(/["']/g, '')}"`;
      i = j + 1;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

export function extractLayoutFromComponent(source: string, pageName: string, id: string): PageLayout {
  const found: Found[] = [];
  for (const match of blankAttributeExpressions(source).matchAll(TAG_PATTERN)) {
    const [, tag, attributes = '', inner = ''] = match;
    if (tag === undefined) continue;
    const element = classify(tag, attributes, inner);
    if (element !== null) found.push({ index: match.index ?? 0, ...element });
  }
  return { id, pageName, elements: place(found) };
}

function classify(tag: string, attributes: string, inner: string): Omit<Found, 'index'> | null {
  if (tag === 'hr') return { type: 'divider', label: '' };
  if (tag === 'img') return { type: 'image', label: attribute(attributes, 'alt') ?? 'Image' };
  if (tag === 'textarea') return { type: 'textarea', label: attribute(attributes, 'placeholder') ?? 'Text' };
  if (tag === 'select') return { type: 'select', label: firstOption(inner) ?? 'Select' };
  if (tag === 'input') {
    const type = attribute(attributes, 'type') ?? 'text';
    if (type === 'hidden' || type === 'submit') return null;
    if (type === 'checkbox') return { type: 'checkbox', label: attribute(attributes, 'name') ?? 'Option' };
    if (type === 'radio') return { type: 'radio', label: attribute(attributes, 'name') ?? 'Option' };
    return { type: 'input', label: attribute(attributes, 'placeholder') ?? attribute(attributes, 'name') ?? 'Input' };
  }

  const text = visibleText(inner);
  if (text === '') return null;
  if (tag.startsWith('h')) return { type: 'heading', label: text };
  if (tag === 'button') return { type: 'button', label: text };
  if (tag === 'a') return { type: 'link', label: text };
  // <label> wrapping a checkbox/radio input is that control's label; any other label is plain text.
  if (tag === 'label') {
    const nested = /<input\b[^>]*type=["'](checkbox|radio)["']/.exec(inner);
    if (nested?.[1] === 'checkbox') return { type: 'checkbox', label: text };
    if (nested?.[1] === 'radio') return { type: 'radio', label: text };
    return { type: 'text', label: text };
  }
  return { type: 'text', label: text };
}

function attribute(attributes: string, name: string): string | null {
  const literal = new RegExp(`\\b${name}=["']([^"']*)["']`).exec(attributes);
  if (literal?.[1] !== undefined && literal[1].trim() !== '') return literal[1].trim();
  const expression = new RegExp(`\\b${name}=\\{([^}]*)\\}`).exec(attributes);
  if (expression?.[1] !== undefined) {
    const placeholder = placeholderFor(expression[1]);
    return placeholder === '' ? null : placeholder;
  }
  return null;
}

function firstOption(inner: string): string | null {
  const option = /<option\b[^>]*>([\s\S]*?)<\/option>/.exec(inner);
  const text = option?.[1] === undefined ? '' : visibleText(option[1]);
  return text === '' ? null : text;
}

/** Inner JSX to the text a visitor would read: nested tags dropped, `{expr}` turned into a placeholder, whitespace collapsed. */
function visibleText(inner: string): string {
  const withPlaceholders = inner.replace(/\{([^{}]*)\}/g, (_match, expression: string) => ` ${placeholderFor(expression)} `);
  return withPlaceholders
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** `product.name` -> "Name", `` `Total: ${total}` `` -> "Total: Total", `'literal'` -> literal. A call or something unreadable -> "". */
function placeholderFor(expression: string): string {
  const trimmed = expression.trim();
  const quoted = /^["'`]([^"'`]*)["'`]$/.exec(trimmed);
  if (quoted?.[1] !== undefined) return quoted[1].replace(/\$\{([^}]*)\}/g, (_m, inner: string) => placeholderFor(inner));
  const identifier = /([A-Za-z_$][\w$]*)\s*\)?\s*$/.exec(trimmed.replace(/\?\?.*$/, '').replace(/\|\|.*$/, ''));
  if (identifier?.[1] === undefined) return '';
  const name = identifier[1];
  if (name.length <= 1) return '';
  return name.charAt(0).toUpperCase() + name.slice(1).replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** Reading order, top to bottom, flowing into a second column once the first is full. Elements that fit in neither column are dropped - the canvas is a fixed 1280x800. */
function place(found: readonly Found[]): CanvasElement[] {
  const ordered = [...found].sort((a, b) => a.index - b.index);
  const columns = Math.max(1, Math.floor((CANVAS_WIDTH - MARGIN * 2 + COLUMN_GAP) / (COLUMN_WIDTH + COLUMN_GAP)));
  const placed: CanvasElement[] = [];
  let column = 0;
  let y = MARGIN;
  let counter = 0;

  for (const item of ordered) {
    const height = HEIGHT[item.type];
    if (y + height > CANVAS_HEIGHT - MARGIN) {
      column += 1;
      y = MARGIN;
      if (column >= columns) break;
    }
    counter += 1;
    placed.push({
      id: `el-${counter}`,
      type: item.type,
      x: MARGIN + column * (COLUMN_WIDTH + COLUMN_GAP),
      y,
      width: WIDTH[item.type],
      height,
      label: item.label,
      colorToken: item.type === 'button' || item.type === 'link' ? 'primary' : item.type === 'divider' ? 'neutral' : 'dark',
    });
    y += height + ROW_GAP;
  }
  return placed;
}
