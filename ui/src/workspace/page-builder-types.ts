/**
 * Mirrors src/generate/canvas-layout.ts's types, hand-duplicated for the
 * same rule-4 reason every other mirror file in this directory documents
 * for itself: ui/ must not import from src/ directly. Do not add fields
 * here beyond what the real types have, and do not rename anything.
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

export const DESIGN_TOKEN_NAMES: readonly DesignToken[] = Object.keys(
  DESIGN_TOKENS,
) as DesignToken[];

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
  readonly id: string;
  readonly type: CanvasElementType;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly colorToken: DesignToken;
}

export const CANVAS_WIDTH = 1280;
export const CANVAS_HEIGHT = 800;

export interface PageLayout {
  readonly id: string;
  readonly pageName: string;
  readonly elements: readonly CanvasElement[];
}

export interface GeneratedPageFile {
  readonly path: string;
  readonly contents: string;
}
