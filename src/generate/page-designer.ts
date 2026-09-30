/**
 * The Page Builder's designer agent: a request in words ("add a hero with a
 * sign-up button, then a pricing section") becomes a short list of edits to
 * the canvas - add, update, remove - that the builder applies as one undo
 * step.
 *
 * The model only proposes; this file decides. Every operation is checked
 * against the real element catalogue (CANVAS_ELEMENT_TYPES), the design
 * tokens and animations, and the fixed 1280x800 canvas: an unknown type is
 * refused, a position is clamped onto the page, an update or removal of an
 * element that does not exist is dropped. So whatever the model says, the
 * canvas can only ever hold elements the generator knows how to write.
 *
 * Operations name elements by id and never replace the whole canvas, so a
 * person editing by hand while the agent thinks keeps their changes: the
 * builder applies the operations to the canvas as it is when they arrive.
 */
import {
  ANIMATION_NAMES,
  CANVAS_ELEMENT_TYPES,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  DESIGN_TOKEN_NAMES,
  type AnimationName,
  type CanvasElement,
  type CanvasElementType,
  type DesignToken,
} from './canvas-layout.js';
import { err, ok, type Result } from '../types/result.js';
import type { CompletionProvider } from '../llm/provider.js';

export const MAX_OPERATIONS = 60;
const MAX_LABEL_LENGTH = 300;
const MIN_SIZE = 8;

export type DesignOperation =
  | {
      readonly op: 'add';
      readonly type: CanvasElementType;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly label: string;
      readonly colorToken: DesignToken;
      readonly animation?: AnimationName;
    }
  | {
      readonly op: 'update';
      readonly id: string;
      readonly x?: number;
      readonly y?: number;
      readonly width?: number;
      readonly height?: number;
      readonly label?: string;
      readonly colorToken?: DesignToken;
      readonly animation?: AnimationName | null;
    }
  | { readonly op: 'remove'; readonly id: string };

export interface DesignReply {
  /** One or two sentences for the chat: what was changed, or why nothing was. */
  readonly reply: string;
  readonly operations: readonly DesignOperation[];
  /** Operations the model proposed that were refused (unknown type, missing element, malformed). */
  readonly refused: number;
}

export interface DesignRequest {
  readonly instruction: string;
  readonly elements: readonly CanvasElement[];
  /** The last few chat turns, oldest first, so "make it bigger" knows what "it" is. */
  readonly history?: readonly { readonly role: 'user' | 'designer'; readonly text: string }[];
}

export type DesignFailure =
  | { readonly reason: 'provider-error'; readonly message: string }
  | { readonly reason: 'unparseable'; readonly message: string };

/** The JSON shape asked of the model; operations are validated again on the way back. */
export const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'update', 'remove'] },
          id: { type: 'string' },
          type: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          label: { type: 'string' },
          colorToken: { type: 'string' },
          animation: { type: 'string' },
        },
        required: ['op'],
      },
    },
  },
  required: ['reply', 'operations'],
} as const;

export const DESIGNER_SYSTEM_PROMPT = [
  'You are the designer agent inside a visual web page builder. You change the page by returning edit operations as JSON.',
  `The page is a fixed ${CANVAS_WIDTH}x${CANVAS_HEIGHT} pixel canvas; x grows to the right and y grows downward from the top-left corner (0,0).`,
  'Elements are absolutely positioned rectangles. Lay them out cleanly: align edges, leave 24-48px gaps, keep everything inside the canvas, avoid overlaps unless an element is meant to sit on a background.',
  `Element types you may use (exactly these names): ${CANVAS_ELEMENT_TYPES.join(', ')}.`,
  `Colours (colorToken): ${DESIGN_TOKEN_NAMES.join(', ')}. Optional entrance animations: ${ANIMATION_NAMES.join(', ')}.`,
  'The label is the visible text: a heading\'s words, a button\'s caption, an input\'s placeholder, an image\'s description.',
  'Operations: {"op":"add","type","x","y","width","height","label","colorToken","animation"?} to place a new element;',
  '{"op":"update","id", ...only the fields to change} to move, resize, relabel or recolour an existing element (use its id from the current page);',
  '{"op":"remove","id"} to delete one.',
  `Return at most ${MAX_OPERATIONS} operations. Reply with JSON only: {"reply": "one or two sentences saying what you changed", "operations": [...]}.`,
  'If the request is unclear or impossible, return no operations and ask a short question in "reply".',
].join('\n');

export function buildDesignerUserPrompt(request: DesignRequest): string {
  const page = request.elements.map((element) =>
    JSON.stringify({ id: element.id, type: element.type, x: element.x, y: element.y, width: element.width, height: element.height, label: element.label, colorToken: element.colorToken }),
  );
  const history = (request.history ?? []).slice(-6).map((turn) => `${turn.role === 'user' ? 'Person' : 'You'}: ${turn.text}`);
  return [
    `Current page (${request.elements.length} element${request.elements.length === 1 ? '' : 's'}):`,
    page.length === 0 ? '(empty)' : page.join('\n'),
    ...(history.length === 0 ? [] : ['', 'Conversation so far:', ...history]),
    '',
    `Request: ${request.instruction.trim()}`,
  ].join('\n');
}

const KNOWN_TYPES: ReadonlySet<string> = new Set(CANVAS_ELEMENT_TYPES);
const KNOWN_TOKENS: ReadonlySet<string> = new Set(DESIGN_TOKEN_NAMES);
const KNOWN_ANIMATIONS: ReadonlySet<string> = new Set(ANIMATION_NAMES);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

/** A rectangle forced onto the canvas: sizes at least MIN_SIZE and at most the canvas, then positions so it fits. */
function fitRect(x: number, y: number, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const w = Math.round(clamp(width, MIN_SIZE, CANVAS_WIDTH));
  const h = Math.round(clamp(height, MIN_SIZE, CANVAS_HEIGHT));
  return { x: Math.round(clamp(x, 0, CANVAS_WIDTH - w)), y: Math.round(clamp(y, 0, CANVAS_HEIGHT - h)), width: w, height: h };
}

const labelOf = (value: unknown): string => (typeof value === 'string' ? value.slice(0, MAX_LABEL_LENGTH) : '');

function checkAdd(raw: Record<string, unknown>): DesignOperation | null {
  const type = raw['type'];
  if (typeof type !== 'string' || !KNOWN_TYPES.has(type)) return null;
  if (!finite(raw['x']) || !finite(raw['y']) || !finite(raw['width']) || !finite(raw['height'])) return null;
  const token = typeof raw['colorToken'] === 'string' && KNOWN_TOKENS.has(raw['colorToken']) ? (raw['colorToken'] as DesignToken) : 'primary';
  const animation = typeof raw['animation'] === 'string' && KNOWN_ANIMATIONS.has(raw['animation']) ? (raw['animation'] as AnimationName) : undefined;
  return {
    op: 'add',
    type: type as CanvasElementType,
    ...fitRect(raw['x'], raw['y'], raw['width'], raw['height']),
    label: labelOf(raw['label']),
    colorToken: token,
    ...(animation === undefined ? {} : { animation }),
  };
}

function checkUpdate(raw: Record<string, unknown>, existing: ReadonlyMap<string, CanvasElement>): DesignOperation | null {
  const target = typeof raw['id'] === 'string' ? existing.get(raw['id']) : undefined;
  if (target === undefined) return null;
  const moved = ['x', 'y', 'width', 'height'].some((key) => finite(raw[key]));
  const rect = moved
    ? fitRect(
        finite(raw['x']) ? raw['x'] : target.x,
        finite(raw['y']) ? raw['y'] : target.y,
        finite(raw['width']) ? raw['width'] : target.width,
        finite(raw['height']) ? raw['height'] : target.height,
      )
    : {};
  const token = typeof raw['colorToken'] === 'string' && KNOWN_TOKENS.has(raw['colorToken']) ? { colorToken: raw['colorToken'] as DesignToken } : {};
  const label = typeof raw['label'] === 'string' ? { label: labelOf(raw['label']) } : {};
  const animation =
    raw['animation'] === null || raw['animation'] === 'none'
      ? { animation: null }
      : typeof raw['animation'] === 'string' && KNOWN_ANIMATIONS.has(raw['animation'])
        ? { animation: raw['animation'] as AnimationName }
        : {};
  const change = { ...rect, ...token, ...label, ...animation };
  return Object.keys(change).length === 0 ? null : { op: 'update', id: target.id, ...change };
}

/** Keeps only the operations the builder can apply; counts the rest as refused. */
export function checkOperations(raw: unknown, elements: readonly CanvasElement[]): { readonly operations: readonly DesignOperation[]; readonly refused: number } {
  const list = Array.isArray(raw) ? raw.slice(0, MAX_OPERATIONS) : [];
  const existing = new Map(elements.map((element) => [element.id, element]));
  const operations: DesignOperation[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const checked =
      record['op'] === 'add'
        ? checkAdd(record)
        : record['op'] === 'update'
          ? checkUpdate(record, existing)
          : record['op'] === 'remove' && typeof record['id'] === 'string' && existing.has(record['id'])
            ? ({ op: 'remove', id: record['id'] } as const)
            : null;
    if (checked !== null) operations.push(checked);
  }
  return { operations, refused: (Array.isArray(raw) ? raw.length : 0) - operations.length };
}

/** Reads the model's JSON, tolerating a fenced block or prose around it. */
export function parseDesignReply(text: string, elements: readonly CanvasElement[]): Result<DesignReply, DesignFailure> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return err({ reason: 'unparseable', message: 'the designer did not answer with JSON' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return err({ reason: 'unparseable', message: 'the designer answered with malformed JSON' });
  }
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const checked = checkOperations(record['operations'], elements);
  const reply = typeof record['reply'] === 'string' && record['reply'].trim() !== '' ? record['reply'].trim() : checked.operations.length > 0 ? 'Done.' : 'I did not change anything.';
  return ok({ reply, ...checked });
}

export async function designPage(provider: CompletionProvider, request: DesignRequest): Promise<Result<DesignReply, DesignFailure>> {
  const completion = await provider.complete({
    system: DESIGNER_SYSTEM_PROMPT,
    user: buildDesignerUserPrompt(request),
    maxOutputTokens: 4096,
    temperature: 0.2,
    schema: DESIGN_SCHEMA,
  });
  if (!completion.ok) return err({ reason: 'provider-error', message: completion.error.message });
  return parseDesignReply(completion.value.text, request.elements);
}
