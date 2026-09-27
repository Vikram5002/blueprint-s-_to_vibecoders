/**
 * The Page Builder's geometry, in one tested place: snapping to a grid and to
 * other elements (with the guide lines to draw), resizing from a handle, and
 * keeping everything on the 1280x800 canvas.
 *
 * All values are CANVAS coordinates. The editor may show the canvas zoomed;
 * callers divide screen deltas by the zoom before they get here, so nothing
 * in this file knows zoom exists.
 */
import { CANVAS_HEIGHT, CANVAS_WIDTH, type CanvasElement } from './page-builder-types';

export const GRID = 8;
/** How close (canvas px) an edge must be to another element's edge or centre to snap to it. */
export const SNAP_DISTANCE = 6;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Guide {
  readonly axis: 'x' | 'y';
  /** Canvas coordinate of the line. */
  readonly at: number;
}

export interface Snapped {
  readonly x: number;
  readonly y: number;
  readonly guides: readonly Guide[];
}

export function clampToCanvas(rect: Rect): Rect {
  const width = Math.min(Math.max(1, Math.round(rect.width)), CANVAS_WIDTH);
  const height = Math.min(Math.max(1, Math.round(rect.height)), CANVAS_HEIGHT);
  return {
    width,
    height,
    x: Math.min(Math.max(0, Math.round(rect.x)), CANVAS_WIDTH - width),
    y: Math.min(Math.max(0, Math.round(rect.y)), CANVAS_HEIGHT - height),
  };
}

/** The three lines per axis an element can align on: start, centre, end. */
function lines(start: number, size: number): readonly number[] {
  return [start, start + size / 2, start + size];
}

/** The best alignment on one axis: the smallest move that lines one of `own` up with one of `targets`. */
function align(ownStart: number, size: number, targets: readonly number[]): { readonly offset: number; readonly at: number } | null {
  let best: { offset: number; at: number } | null = null;
  for (const line of lines(ownStart, size)) {
    for (const target of targets) {
      const offset = target - line;
      if (Math.abs(offset) <= SNAP_DISTANCE && (best === null || Math.abs(offset) < Math.abs(best.offset))) best = { offset, at: target };
    }
  }
  return best;
}

/**
 * Snaps a moving rect: to another element's edges/centres (or the canvas's)
 * when within SNAP_DISTANCE, otherwise to the grid. Returns the guides that
 * explain the element snaps, so the editor can draw them.
 */
export function snapMove(rect: Rect, others: readonly Rect[]): Snapped {
  const xTargets = [0, CANVAS_WIDTH / 2, CANVAS_WIDTH, ...others.flatMap((o) => lines(o.x, o.width))];
  const yTargets = [0, CANVAS_HEIGHT / 2, CANVAS_HEIGHT, ...others.flatMap((o) => lines(o.y, o.height))];
  const ax = align(rect.x, rect.width, xTargets);
  const ay = align(rect.y, rect.height, yTargets);
  const x = ax !== null ? rect.x + ax.offset : Math.round(rect.x / GRID) * GRID;
  const y = ay !== null ? rect.y + ay.offset : Math.round(rect.y / GRID) * GRID;
  const guides: Guide[] = [];
  if (ax !== null) guides.push({ axis: 'x', at: ax.at });
  if (ay !== null) guides.push({ axis: 'y', at: ay.at });
  const clamped = clampToCanvas({ ...rect, x, y });
  return { x: clamped.x, y: clamped.y, guides };
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export const MIN_SIZE = 8;

/** The rect after dragging `handle` by (dx, dy) canvas px, grid-snapped, never smaller than MIN_SIZE, kept on the canvas. */
export function resizeRect(start: Rect, handle: Handle, dx: number, dy: number): Rect {
  let { x, y, width, height } = start;
  const snap = (value: number): number => Math.round(value / GRID) * GRID;
  if (handle.includes('e')) width = Math.max(MIN_SIZE, snap(start.x + start.width + dx) - start.x);
  if (handle.includes('s')) height = Math.max(MIN_SIZE, snap(start.y + start.height + dy) - start.y);
  if (handle.includes('w')) {
    const right = start.x + start.width;
    x = Math.min(snap(start.x + dx), right - MIN_SIZE);
    width = right - x;
  }
  if (handle.includes('n')) {
    const bottom = start.y + start.height;
    y = Math.min(snap(start.y + dy), bottom - MIN_SIZE);
    height = bottom - y;
  }
  if (x < 0) {
    width += x;
    x = 0;
  }
  if (y < 0) {
    height += y;
    y = 0;
  }
  return clampToCanvas({ x, y, width: Math.min(width, CANVAS_WIDTH - x), height: Math.min(height, CANVAS_HEIGHT - y) });
}

/** Everything except the element being moved, as rects - what it can align to. */
export function otherRects(elements: readonly CanvasElement[], exceptId: string): readonly Rect[] {
  return elements.filter((element) => element.id !== exceptId);
}

/** Moves an element one step in the paint order (later = on top). */
export function reorder(elements: readonly CanvasElement[], id: string, direction: 'forward' | 'backward' | 'front' | 'back'): readonly CanvasElement[] {
  const index = elements.findIndex((element) => element.id === id);
  if (index === -1) return elements;
  const list = [...elements];
  const [item] = list.splice(index, 1);
  if (item === undefined) return elements;
  const target =
    direction === 'front' ? list.length : direction === 'back' ? 0 : direction === 'forward' ? Math.min(list.length, index + 1) : Math.max(0, index - 1);
  list.splice(target, 0, item);
  return list;
}
