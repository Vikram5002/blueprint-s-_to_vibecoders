import { describe, expect, it } from 'vitest';
import { buildDesignerUserPrompt, checkOperations, designPage, MAX_OPERATIONS, parseDesignReply } from './page-designer.js';
import type { CanvasElement } from './canvas-layout.js';
import type { CompletionProvider } from '../llm/provider.js';

const BUTTON: CanvasElement = { id: 'b1', type: 'button', x: 100, y: 100, width: 160, height: 40, label: 'Sign up', colorToken: 'primary' };

describe('checkOperations', () => {
  it('accepts an add of a known type, filling in a missing colour', () => {
    const { operations, refused } = checkOperations([{ op: 'add', type: 'heading', x: 40, y: 40, width: 600, height: 60, label: 'Welcome' }], []);
    expect(refused).toBe(0);
    expect(operations).toEqual([{ op: 'add', type: 'heading', x: 40, y: 40, width: 600, height: 60, label: 'Welcome', colorToken: 'primary' }]);
  });

  it('refuses an unknown element type rather than inventing one', () => {
    const { operations, refused } = checkOperations([{ op: 'add', type: 'hologram', x: 0, y: 0, width: 10, height: 10, label: '' }], []);
    expect(operations).toEqual([]);
    expect(refused).toBe(1);
  });

  it('clamps a rectangle onto the 1280x800 canvas', () => {
    const { operations } = checkOperations([{ op: 'add', type: 'text', x: 1250, y: -30, width: 400, height: 2, label: 'edge' }], []);
    expect(operations[0]).toMatchObject({ x: 880, y: 0, width: 400, height: 8 });
  });

  it('updates only the fields given, and only on elements that exist', () => {
    const { operations, refused } = checkOperations(
      [
        { op: 'update', id: 'b1', label: 'Join now', colorToken: 'success' },
        { op: 'update', id: 'missing', label: 'x' },
        { op: 'update', id: 'b1', x: 20 },
      ],
      [BUTTON],
    );
    expect(refused).toBe(1);
    expect(operations).toEqual([
      { op: 'update', id: 'b1', label: 'Join now', colorToken: 'success' },
      { op: 'update', id: 'b1', x: 20, y: 100, width: 160, height: 40 },
    ]);
  });

  it('removes existing elements only, ignores an unknown colour, and caps the list', () => {
    expect(checkOperations([{ op: 'remove', id: 'b1' }, { op: 'remove', id: 'nope' }], [BUTTON]).operations).toEqual([{ op: 'remove', id: 'b1' }]);
    expect(checkOperations([{ op: 'update', id: 'b1', colorToken: 'rainbow' }], [BUTTON]).operations).toEqual([]);
    const many = Array.from({ length: 80 }, () => ({ op: 'add', type: 'text', x: 0, y: 0, width: 50, height: 20, label: 't' }));
    expect(checkOperations(many, []).operations).toHaveLength(MAX_OPERATIONS);
  });
});

describe('parseDesignReply', () => {
  it('reads JSON wrapped in prose or a code fence', () => {
    const reply = parseDesignReply('Sure!\n```json\n{"reply":"Added a title.","operations":[{"op":"add","type":"heading","x":0,"y":0,"width":300,"height":50,"label":"Hi"}]}\n```', []);
    expect(reply.ok && reply.value.reply).toBe('Added a title.');
    expect(reply.ok && reply.value.operations).toHaveLength(1);
  });

  it('says so when there is no JSON at all', () => {
    const reply = parseDesignReply('I cannot help with that.', []);
    expect(reply.ok).toBe(false);
  });
});

describe('the prompt and the call', () => {
  it('shows the model the current page with ids, and the recent conversation', () => {
    const prompt = buildDesignerUserPrompt({ instruction: 'make it green', elements: [BUTTON], history: [{ role: 'user', text: 'add a sign up button' }] });
    expect(prompt).toContain('"id":"b1"');
    expect(prompt).toContain('Person: add a sign up button');
    expect(prompt).toContain('Request: make it green');
  });

  it('turns a provider failure into a provider-error', async () => {
    const provider: CompletionProvider = { name: 'x', model: 'x', complete: async () => ({ ok: false, error: { kind: 'unavailable', message: 'quota' } }) };
    const result = await designPage(provider, { instruction: 'add a footer', elements: [] });
    expect(!result.ok && result.error.reason).toBe('provider-error');
  });
});
