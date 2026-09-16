/**
 * Page builder: turns a real, user-placed canvas layout into one real
 * `.tsx` file - deterministically, with NO LLM call for the visual part.
 *
 * This is deliberately the opposite direction from
 * `component-codegen.ts`'s pipeline: that machinery turns free PROSE into
 * code, which is exactly right for "implement a component that does X" but
 * exactly wrong for "put this button at this pixel position in this exact
 * color" - a canvas position and a hex value are not things an LLM should
 * be asked to reproduce faithfully, they are data that must map 1:1. So
 * this file is templated generation, the same posture `assemble.ts`
 * already takes for entry points, applied to page content instead of
 * wiring.
 *
 * Still reuses the established generation conventions rather than
 * inventing new ones: `pascalIdentifier`/`componentSlug` from
 * `assemble.ts` produce the exact same identifier/path shape every other
 * generated frontend page already uses, so a page built here could plug
 * into `frontendEntryPointFile` unchanged if it were ever attached to a
 * real `ProjectSchema` (still deliberately stand-alone here, generating
 * one file with no entry point or package.json of its own).
 *
 * Element set covers the common building blocks of a page's static
 * structure and content - headings, text, links, images, buttons, the
 * standard form controls, a divider, and a grouping container - not every
 * HTML element that exists (a `<table>`, `<video>`, `<canvas>` etc. are
 * out of scope: each would need real data or an asset pipeline this
 * feature doesn't have, not just a position and a color).
 */
import { componentSlug, pascalIdentifier, type GeneratedFile } from './assemble.js';

/**
 * Fixed, closed palette - a lookup, never free-form CSS or an arbitrary hex
 * value. See the design proposal's own reasoning: an open "any color"
 * option reintroduces exactly the "guess what free text means" risk this
 * project has spent Milestones 1-4 eliminating from code generation. An
 * unrecognized token name is a hard validation error in
 * `layoutToComponentFile` below, never silently defaulted.
 */
export const DESIGN_TOKENS = {
  primary: '#2563eb',
  secondary: '#7c3aed',
  neutral: '#475569',
  danger: '#dc2626',
  success: '#16a34a',
  warning: '#d97706',
  dark: '#0f172a',
  light: '#f8fafc',
} as const;

export type DesignToken = keyof typeof DESIGN_TOKENS;

export const DESIGN_TOKEN_NAMES: readonly DesignToken[] = Object.keys(DESIGN_TOKENS) as DesignToken[];

/**
 * Entry animations, as a fixed closed catalogue for the same reason
 * DESIGN_TOKENS is one: an open "any CSS animation" field would hand the
 * generator arbitrary text to paste into a stylesheet, which is exactly the
 * "guess what free text means" risk this whole feature avoids. An
 * unrecognized name is a hard validation error, never silently dropped.
 *
 * `keyframes` is the literal @keyframes body and `timing` the animation
 * shorthand's tail - both copied verbatim into the generated file, never
 * assembled from user input. Only the animations a layout actually uses are
 * emitted, so a page with no animated elements generates no <style> block at
 * all and is byte-identical to what it produced before this existed.
 */
export interface AnimationSpec {
  /** Shown in the picker; never appears in generated output. */
  readonly label: string;
  readonly keyframes: string;
  /** Everything after the keyframes name in the `animation` shorthand. */
  readonly timing: string;
}

export const ANIMATIONS = {
  'fade-in': {
    label: 'Fade in',
    keyframes: 'from { opacity: 0; } to { opacity: 1; }',
    timing: '600ms ease-out both',
  },
  'slide-up': {
    label: 'Slide up',
    keyframes: 'from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); }',
    timing: '600ms ease-out both',
  },
  'slide-down': {
    label: 'Slide down',
    keyframes: 'from { opacity: 0; transform: translateY(-24px); } to { opacity: 1; transform: translateY(0); }',
    timing: '600ms ease-out both',
  },
  'slide-left': {
    label: 'Slide in from right',
    keyframes: 'from { opacity: 0; transform: translateX(32px); } to { opacity: 1; transform: translateX(0); }',
    timing: '600ms ease-out both',
  },
  'slide-right': {
    label: 'Slide in from left',
    keyframes: 'from { opacity: 0; transform: translateX(-32px); } to { opacity: 1; transform: translateX(0); }',
    timing: '600ms ease-out both',
  },
  'zoom-in': {
    label: 'Zoom in',
    keyframes: 'from { opacity: 0; transform: scale(0.85); } to { opacity: 1; transform: scale(1); }',
    timing: '450ms ease-out both',
  },
  pulse: {
    label: 'Pulse (loops)',
    keyframes: '0%, 100% { opacity: 1; } 50% { opacity: 0.55; }',
    timing: '1.8s ease-in-out infinite',
  },
  bounce: {
    label: 'Bounce (loops)',
    keyframes: '0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); }',
    timing: '1.4s ease-in-out infinite',
  },
} as const satisfies Record<string, AnimationSpec>;

export type AnimationName = keyof typeof ANIMATIONS;

export const ANIMATION_NAMES: readonly AnimationName[] = Object.keys(ANIMATIONS) as AnimationName[];

/** Prefixed so a generated page's keyframes can never collide with whatever else is already on the page it is dropped into. */
export function keyframesIdentifier(animation: AnimationName): string {
  return `vb-${animation}`;
}

export type CanvasElementType =
  | 'heading'
  | 'text'
  | 'button'
  | 'link'
  | 'image'
  | 'input'
  | 'textarea'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'divider'
  | 'container';

/** Every type this feature can place - kept in one array so the server-side shape check (page-builder-api.ts) and the UI palette can both derive from a single source of truth rather than two hand-kept lists drifting apart. */
export const CANVAS_ELEMENT_TYPES: readonly CanvasElementType[] = [
  'heading',
  'text',
  'button',
  'link',
  'image',
  'input',
  'textarea',
  'checkbox',
  'radio',
  'select',
  'divider',
  'container',
];

export interface CanvasElement {
  /** Content-derived would be ideal, but placement is inherently orderless/mutable during editing - a plain client-generated id is honest about that, unlike componentId's content-derived guarantee for a stated purpose. */
  readonly id: string;
  readonly type: CanvasElementType;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /**
   * The visible/associated text - meaning depends on `type`: the text
   * itself for heading/text/link, a button's label, an image's alt text
   * (rendered as its placeholder caption), a form control's placeholder or
   * adjacent label, an option's text for select. Unused for divider and
   * container, which carry no text of their own.
   */
  readonly label: string;
  readonly colorToken: DesignToken;
  /** Absent means no animation at all - the element generates exactly as it did before animations existed. */
  readonly animation?: AnimationName;
}

/** Fixed 1280x800 canvas per the approved v1 scope - responsive/breakpoint support is explicitly deferred, not reconciled with LayoutSchema's own breakpoints concept in this pass. */
export const CANVAS_WIDTH = 1280;
export const CANVAS_HEIGHT = 800;

export interface PageLayout {
  readonly id: string;
  /** Becomes the generated component's name and file slug. */
  readonly pageName: string;
  readonly elements: readonly CanvasElement[];
}

export type LayoutValidationError =
  | { readonly reason: 'empty-page-name' }
  | { readonly reason: 'unknown-color-token'; readonly elementId: string; readonly token: string }
  | { readonly reason: 'unknown-animation'; readonly elementId: string; readonly animation: string }
  | { readonly reason: 'out-of-bounds'; readonly elementId: string };

/**
 * Validates before generating anything - never silently clamp an
 * out-of-bounds element or default an unrecognized token, per the same
 * "never guess" discipline the rest of this pipeline already follows.
 */
export function validatePageLayout(layout: PageLayout): readonly LayoutValidationError[] {
  const errors: LayoutValidationError[] = [];

  if (layout.pageName.trim() === '') {
    errors.push({ reason: 'empty-page-name' });
  }

  for (const element of layout.elements) {
    if (!(element.colorToken in DESIGN_TOKENS)) {
      errors.push({ reason: 'unknown-color-token', elementId: element.id, token: element.colorToken });
    }
    if (element.animation !== undefined && !(element.animation in ANIMATIONS)) {
      errors.push({ reason: 'unknown-animation', elementId: element.id, animation: element.animation });
    }
    if (
      element.x < 0 ||
      element.y < 0 ||
      element.x + element.width > CANVAS_WIDTH ||
      element.y + element.height > CANVAS_HEIGHT
    ) {
      errors.push({ reason: 'out-of-bounds', elementId: element.id });
    }
  }

  return errors;
}

/** Repo-relative target path, matching the existing frontend page convention (`componentTargetPath`'s own frontend branch) exactly, so this file could join a real ProjectSchema's assembly unchanged. */
export function pageLayoutTargetPath(layout: PageLayout): string {
  return `frontend/src/pages/${componentSlug(layout.pageName)}.tsx`;
}

/**
 * The one, deterministic template. Every number and color in the output is
 * copied directly from `layout` - nothing here is inferred, summarised, or
 * asked of a model. `data-testid={element.id}` is real, load-bearing
 * markup (not a throwaway comment): it is what lets a live browser
 * verification assert exact rendered position and color against the
 * source data, rather than only eyeballing a screenshot.
 */
export function layoutToComponentFile(layout: PageLayout): GeneratedFile {
  const errors = validatePageLayout(layout);
  if (errors.length > 0) {
    throw new Error(`layoutToComponentFile: invalid layout: ${JSON.stringify(errors)}`);
  }

  const componentName = pascalIdentifier(componentSlug(layout.pageName));

  const elementsJsx = layout.elements
    .map((element) => renderElement(element))
    .map((line) => `      ${line}`)
    .join('\n');

  const contents =
    "import type { FC } from 'react';\n" +
    '\n' +
    `export const ${componentName}: FC = () => {\n` +
    '  return (\n' +
    `    <div style={{ position: 'relative', width: ${CANVAS_WIDTH}, height: ${CANVAS_HEIGHT} }}>\n` +
    renderKeyframesBlock(layout.elements) +
    `${elementsJsx}\n` +
    '    </div>\n' +
    '  );\n' +
    '};\n';

  return { path: pageLayoutTargetPath(layout), contents };
}

/**
 * The @keyframes for exactly the animations this layout uses, inlined as a
 * real `<style>` element rather than written to a separate stylesheet: this
 * feature generates ONE self-contained file, and a second file the consumer
 * has to remember to import would break that (and `frontendEntryPointFile`
 * imports pages, not stylesheets). Emits nothing at all - not even an empty
 * <style> - when no element is animated, so an unanimated page is
 * byte-identical to what this generated before animations existed.
 *
 * Deduplicated and emitted in the catalogue's own fixed order, never the
 * order elements happen to appear in, so the same layout always produces the
 * same bytes regardless of how it was assembled.
 */
function renderKeyframesBlock(elements: readonly CanvasElement[]): string {
  const used = new Set(
    elements.flatMap((element) => (element.animation === undefined ? [] : [element.animation])),
  );
  if (used.size === 0) return '';

  const rules = ANIMATION_NAMES.filter((name) => used.has(name))
    .map((name) => `@keyframes ${keyframesIdentifier(name)} { ${ANIMATIONS[name].keyframes} }`)
    .join('\n');

  return `      <style>{\`\n${rules}\n\`}</style>\n`;
}

/**
 * Every generated element is absolutely positioned within the fixed canvas -
 * the one thing every type shares, so it is computed once here rather than
 * repeated in each branch below. The animation shorthand rides along in the
 * same place for the same reason: it applies identically to all twelve types,
 * and threading it through each branch separately would be twelve chances to
 * forget one.
 */
function positionStyle(element: CanvasElement): string {
  const base =
    `position: 'absolute', left: ${element.x}, top: ${element.y}, ` +
    `width: ${element.width}, height: ${element.height}`;

  if (element.animation === undefined) return base;
  const spec = ANIMATIONS[element.animation];
  return `${base}, animation: '${keyframesIdentifier(element.animation)} ${spec.timing}'`;
}

function renderElement(element: CanvasElement): string {
  const color = DESIGN_TOKENS[element.colorToken];
  const position = positionStyle(element);
  const text = escapeJsxText(element.label);

  switch (element.type) {
    case 'heading':
      return (
        `<h2 data-testid="${element.id}" style={{ ${position}, color: '${color}', margin: 0, ` +
        `fontSize: 28, fontWeight: 700 }}>${text}</h2>`
      );

    case 'text':
      return `<span data-testid="${element.id}" style={{ ${position}, color: '${color}' }}>${text}</span>`;

    case 'button':
      return (
        `<button type="button" data-testid="${element.id}" style={{ ${position}, ` +
        `backgroundColor: '${color}', color: '#ffffff', border: 'none', borderRadius: 4 }}>${text}</button>`
      );

    case 'link':
      return (
        `<a href="#" data-testid="${element.id}" style={{ ${position}, color: '${color}', ` +
        `textDecoration: 'underline' }}>${text}</a>`
      );

    case 'image':
      // No real asset pipeline exists here - a labelled, dashed-border
      // placeholder box is the honest representation of "an image goes
      // here", never a fabricated <img src> pointing at a file that does
      // not exist.
      return (
        `<div data-testid="${element.id}" role="img" aria-label="${text}" style={{ ${position}, ` +
        `border: '2px dashed ${color}', borderRadius: 4, display: 'flex', alignItems: 'center', ` +
        `justifyContent: 'center', color: '${color}', boxSizing: 'border-box' }}>${text}</div>`
      );

    case 'input':
      return (
        `<input type="text" data-testid="${element.id}" placeholder="${text}" style={{ ${position}, ` +
        `border: '1px solid ${color}', borderRadius: 4, boxSizing: 'border-box', padding: '0 8px' }} />`
      );

    case 'textarea':
      return (
        `<textarea data-testid="${element.id}" placeholder="${text}" style={{ ${position}, ` +
        `border: '1px solid ${color}', borderRadius: 4, boxSizing: 'border-box', padding: 8, resize: 'none' }} />`
      );

    case 'checkbox':
    case 'radio':
      return (
        `<label data-testid="${element.id}" style={{ ${position}, display: 'flex', alignItems: 'center', ` +
        `gap: 8, color: '${color}', boxSizing: 'border-box' }}><input type="${element.type}" />${text}</label>`
      );

    case 'select':
      return (
        `<select data-testid="${element.id}" style={{ ${position}, border: '1px solid ${color}', ` +
        `borderRadius: 4, boxSizing: 'border-box' }}><option>${text}</option></select>`
      );

    case 'divider':
      return (
        `<hr data-testid="${element.id}" style={{ ${position}, border: 'none', ` +
        `borderTop: '2px solid ${color}', margin: 0 }} />`
      );

    case 'container':
      return (
        `<div data-testid="${element.id}" style={{ ${position}, border: '2px solid ${color}', ` +
        `borderRadius: 8, boxSizing: 'border-box' }} />`
      );
  }
}

/** JSX text content - only the characters that would otherwise break out of the tag or the string need escaping, since this text is never itself an attribute value. */
function escapeJsxText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
}
