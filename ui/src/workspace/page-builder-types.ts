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

/** Mirrors src/generate/canvas-layout.ts's ANIMATIONS - same names, same keyframes, same timings, so the editor preview animates identically to the generated file. */
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
} as const;

export type AnimationName = keyof typeof ANIMATIONS;

export const ANIMATION_NAMES: readonly AnimationName[] = Object.keys(ANIMATIONS) as AnimationName[];

export function keyframesIdentifier(animation: AnimationName): string {
  return `vb-${animation}`;
}

export interface CanvasElement {
  readonly id: string;
  readonly type: CanvasElementType;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly colorToken: DesignToken;
  readonly animation?: AnimationName;
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
