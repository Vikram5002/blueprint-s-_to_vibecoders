/**
 * HTTP surface for the page builder's Milestone 1: turns a real,
 * user-placed canvas layout into one real `.tsx` file.
 *
 * Deliberately synchronous, not submit-and-poll like workflow-api.ts /
 * generation-api.ts: `layoutToComponentFile` makes no LLM call and no
 * subprocess call, so there is nothing here that can take more than a
 * few milliseconds - a job queue would be solving a problem this endpoint
 * does not have. Mounted unconditionally (never gated on an LLM provider
 * being configured), since this pass needs none.
 */
import { Hono } from 'hono';
import {
  CANVAS_ELEMENT_TYPES,
  layoutToComponentFile,
  validatePageLayout,
  type CanvasElement,
  type CanvasElementType,
  type PageLayout,
} from '../generate/canvas-layout.js';

const KNOWN_ELEMENT_TYPES: ReadonlySet<string> = new Set(CANVAS_ELEMENT_TYPES);

function isCanvasElement(value: unknown): value is CanvasElement {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['type'] === 'string' &&
    KNOWN_ELEMENT_TYPES.has(record['type'] as CanvasElementType) &&
    typeof record['x'] === 'number' &&
    typeof record['y'] === 'number' &&
    typeof record['width'] === 'number' &&
    typeof record['height'] === 'number' &&
    typeof record['label'] === 'string' &&
    typeof record['colorToken'] === 'string'
  );
}

/** Structural shape check only - `validatePageLayout` (canvas-layout.ts) does the real semantic validation (bounds, known color tokens). This just refuses a body that is not even shaped like a PageLayout, before anything downstream has to guess. */
function parsePageLayout(body: unknown): PageLayout | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const layout = record['layout'];
  if (typeof layout !== 'object' || layout === null) return null;
  const candidate = layout as Record<string, unknown>;

  if (typeof candidate['id'] !== 'string' || typeof candidate['pageName'] !== 'string') return null;
  if (!Array.isArray(candidate['elements']) || !candidate['elements'].every(isCanvasElement)) return null;

  return {
    id: candidate['id'],
    pageName: candidate['pageName'],
    elements: candidate['elements'],
  };
}

export function createPageBuilderRoutes(): Hono {
  const app = new Hono();

  app.post('/generate', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const layout = parsePageLayout(body);
    if (layout === null) {
      return c.json({ error: 'expected { layout: PageLayout }' }, 400);
    }

    const errors = validatePageLayout(layout);
    if (errors.length > 0) {
      return c.json({ error: 'layout failed validation', errors }, 400);
    }

    const file = layoutToComponentFile(layout);
    return c.json({ file });
  });

  return app;
}
