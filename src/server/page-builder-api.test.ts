import { describe, expect, it } from 'vitest';
import { createPageBuilderRoutes } from './page-builder-api.js';
import type { PageLayout } from '../generate/canvas-layout.js';

const VALID_LAYOUT: PageLayout = {
  id: 'layout-1',
  pageName: 'Landing Page',
  elements: [
    { id: 'btn-1', type: 'button', x: 100, y: 50, width: 160, height: 40, label: 'Click me', colorToken: 'primary' },
  ],
};

describe('POST /generate', () => {
  it('generates the real file synchronously - no job, no polling', async () => {
    const app = createPageBuilderRoutes();
    const response = await app.request('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout: VALID_LAYOUT }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { file: { path: string; contents: string } };
    expect(body.file.path).toBe('frontend/src/pages/landing-page.tsx');
    expect(body.file.contents).toContain('data-testid="btn-1"');
    expect(body.file.contents).toContain('Click me');
  });

  it('rejects a body with no layout field', async () => {
    const app = createPageBuilderRoutes();
    const response = await app.request('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it('rejects a structurally malformed element rather than guessing its shape', async () => {
    const app = createPageBuilderRoutes();
    const response = await app.request('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        layout: { id: 'x', pageName: 'X', elements: [{ id: 'e1', type: 'button' }] },
      }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects an element whose type is not one of the known CanvasElementType values', async () => {
    const app = createPageBuilderRoutes();
    const response = await app.request('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        layout: {
          id: 'x',
          pageName: 'X',
          elements: [{ id: 'e1', type: 'hologram', x: 0, y: 0, width: 10, height: 10, label: 'x', colorToken: 'primary' }],
        },
      }),
    });
    expect(response.status).toBe(400);
  });

  it('accepts every real element type from the shared CANVAS_ELEMENT_TYPES list, not just button/text', async () => {
    const app = createPageBuilderRoutes();
    const response = await app.request('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        layout: {
          id: 'x',
          pageName: 'Full page',
          elements: [
            { id: 'e1', type: 'heading', x: 0, y: 0, width: 200, height: 40, label: 'Title', colorToken: 'primary' },
            { id: 'e2', type: 'input', x: 0, y: 50, width: 200, height: 36, label: 'Name', colorToken: 'dark' },
            { id: 'e3', type: 'container', x: 0, y: 100, width: 200, height: 200, label: '', colorToken: 'neutral' },
          ],
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { file: { contents: string } };
    expect(body.file.contents).toContain('data-testid="e1"');
    expect(body.file.contents).toContain('data-testid="e2"');
    expect(body.file.contents).toContain('data-testid="e3"');
  });

  it('rejects a semantically invalid layout (unknown color token) with the real validation errors, not a generic 500', async () => {
    const app = createPageBuilderRoutes();
    const response = await app.request('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        layout: {
          id: 'x',
          pageName: 'X',
          elements: [{ id: 'e1', type: 'text', x: 0, y: 0, width: 10, height: 10, label: 'x', colorToken: 'not-real' }],
        },
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; errors: unknown[] };
    expect(body.error).toBe('layout failed validation');
    expect(body.errors).toEqual([{ reason: 'unknown-color-token', elementId: 'e1', token: 'not-real' }]);
  });

  it('accepts an element carrying a real animation, and rejects one naming an animation that does not exist', async () => {
    const app = createPageBuilderRoutes();
    const accepted = await app.request('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        layout: {
          id: 'x',
          pageName: 'Animated',
          elements: [
            { id: 'e1', type: 'button', x: 0, y: 0, width: 100, height: 40, label: 'Go', colorToken: 'primary', animation: 'fade-in' },
          ],
        },
      }),
    });
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as { file: { contents: string } };
    expect(body.file.contents).toContain('@keyframes vb-fade-in');

    const rejected = await app.request('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        layout: {
          id: 'x',
          pageName: 'Animated',
          elements: [
            { id: 'e1', type: 'button', x: 0, y: 0, width: 100, height: 40, label: 'Go', colorToken: 'primary', animation: 'disco' },
          ],
        },
      }),
    });
    expect(rejected.status).toBe(400);
    const errorBody = (await rejected.json()) as { errors: unknown[] };
    expect(errorBody.errors).toEqual([{ reason: 'unknown-animation', elementId: 'e1', animation: 'disco' }]);
  });

  it('rejects an out-of-bounds element the same way', async () => {
    const app = createPageBuilderRoutes();
    const response = await app.request('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        layout: {
          id: 'x',
          pageName: 'X',
          elements: [{ id: 'e1', type: 'text', x: 5000, y: 0, width: 10, height: 10, label: 'x', colorToken: 'dark' }],
        },
      }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects malformed JSON without throwing', async () => {
    const app = createPageBuilderRoutes();
    const response = await app.request('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });
});

describe('POST /design', () => {
  const layout = { id: 'p', pageName: 'Landing', elements: [{ id: 'b1', type: 'button', x: 10, y: 10, width: 160, height: 40, label: 'Go', colorToken: 'primary' }] };
  const post = (app: ReturnType<typeof createPageBuilderRoutes>, body: unknown) =>
    app.request('/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('returns the checked operations and the reply', async () => {
    const answer = JSON.stringify({
      reply: 'Added a heading and relabelled the button.',
      operations: [
        { op: 'add', type: 'heading', x: 40, y: 80, width: 500, height: 60, label: 'Welcome' },
        { op: 'update', id: 'b1', label: 'Join' },
        { op: 'add', type: 'not-a-type', x: 0, y: 0, width: 1, height: 1, label: '' },
      ],
    });
    const app = createPageBuilderRoutes({
      designer: { name: 'stub', model: 'stub', complete: async () => ({ ok: true, value: { text: answer, model: 'stub', usage: { promptTokens: 1, completionTokens: 1, cachedPromptTokens: 0 } } }) },
    });
    const response = await post(app, { instruction: 'add a welcome heading', layout });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { reply: string; operations: { op: string }[]; refused: number };
    expect(body.reply).toBe('Added a heading and relabelled the button.');
    expect(body.operations.map((operation) => operation.op)).toEqual(['add', 'update']);
    expect(body.refused).toBe(1);
  });

  it('503s without a model and 400s without an instruction', async () => {
    expect((await post(createPageBuilderRoutes(), { instruction: 'x', layout })).status).toBe(503);
    expect((await post(createPageBuilderRoutes(), { instruction: ' ', layout })).status).toBe(400);
  });
});
