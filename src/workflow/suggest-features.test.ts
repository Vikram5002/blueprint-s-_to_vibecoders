import { describe, expect, it } from 'vitest';
import {
  changeForSuggestions,
  MAX_SUGGESTIONS,
  parseSuggestions,
  suggestFeatures,
  suggestionRequest,
} from './suggest-features.js';
import { validateProjectSchema } from './validate-project-schema.js';
import { componentId, type ValidatedProjectSchema } from '../types/project-schema.js';
import type { CompletionProvider, CompletionRequest } from '../llm/provider.js';

function cafePlan(): ValidatedProjectSchema {
  const candidate = {
    sessionId: 'suggest-test',
    title: 'Cafe Orders',
    originalPrompt: 'A website for a cafe',
    domains: {
      frontend: {
        components: [
          { id: componentId('frontend', 'Order Page', 'order-page'), name: 'Order Page', purpose: 'Customers order food and drinks.' },
          { id: componentId('frontend', 'Order Queue', 'order-queue'), name: 'Order Queue', purpose: 'Staff see the order queue.' },
        ],
        dependsOn: ['backend'],
      },
      backend: { components: [{ id: componentId('backend', 'Orders API', 'orders-api'), name: 'Orders API', purpose: 'Creates and lists orders.' }], dependsOn: ['database'] },
      database: { components: [{ id: componentId('database', 'orders table', 'orders-table'), name: 'orders table', purpose: 'Stores orders.' }], dependsOn: [] },
      security: { components: [], dependsOn: [] },
    },
    constraints: [],
    provenance: 'STATED' as const,
  };
  const validated = validateProjectSchema(candidate);
  if (!validated.ok) throw new Error(JSON.stringify(validated.error));
  return validated.value;
}

const item = (title: string, change = `Add ${title.toLowerCase()} with its own page and table.`) => ({ title, why: `Customers expect ${title}.`, change });

describe('parseSuggestions', () => {
  const plan = cafePlan();

  it('keeps complete new suggestions in order', () => {
    const text = JSON.stringify({ suggestions: [item('Table booking'), item('Home delivery')] });
    expect(parseSuggestions(text, plan).map((s) => s.title)).toEqual(['Table booking', 'Home delivery']);
  });

  it('drops what the plan already has, duplicates and incomplete entries', () => {
    const text = JSON.stringify({
      suggestions: [item('Order queue'), item('Table booking'), item('table booking'), { title: 'Loyalty points', why: '', change: 'x' }, 'junk'],
    });
    expect(parseSuggestions(text, plan).map((s) => s.title)).toEqual(['Table booking']);
  });

  it(`keeps at most ${MAX_SUGGESTIONS} and returns none for text that is not the expected JSON`, () => {
    const many = JSON.stringify({ suggestions: Array.from({ length: 12 }, (_, i) => item(`Feature number ${'abcdefghijkl'[i]}x`)) });
    expect(parseSuggestions(many, plan)).toHaveLength(MAX_SUGGESTIONS);
    expect(parseSuggestions('not json', plan)).toEqual([]);
    expect(parseSuggestions('{"ideas": []}', plan)).toEqual([]);
  });
});

describe('suggestFeatures', () => {
  const provider = (text: string): CompletionProvider & { calls: CompletionRequest[] } => {
    const calls: CompletionRequest[] = [];
    return {
      calls,
      name: 'stub',
      model: 'stub',
      complete: async (request) => {
        calls.push(request);
        return { ok: true, value: { text, model: 'stub', usage: { promptTokens: 1, completionTokens: 1, cachedPromptTokens: 0 } } };
      },
    };
  };

  it('shows the model the request and every planned component, and asks for JSON', async () => {
    const stub = provider(JSON.stringify({ suggestions: [item('Home delivery')] }));
    const result = await suggestFeatures(stub, 'A website for a cafe', cafePlan());
    expect(result.ok && result.value[0]?.title).toBe('Home delivery');
    expect(stub.calls[0]?.user).toContain('A website for a cafe');
    expect(stub.calls[0]?.user).toContain('- Order Queue: Staff see the order queue.');
    expect(stub.calls[0]?.schema).toBeDefined();
  });

  it('fails plainly when nothing usable comes back', async () => {
    const result = await suggestFeatures(provider('{"suggestions": []}'), 'p', cafePlan());
    expect(result.ok).toBe(false);
  });

  it('asks for the request alone, with the plan listed by domain', () => {
    expect(suggestionRequest('p', cafePlan()).user).toMatch(/frontend:\n- Order Page/);
  });
});

describe('changeForSuggestions', () => {
  it('joins the chosen changes into one plan change', () => {
    expect(changeForSuggestions([item('Table booking', 'Add table booking.'), item('Delivery', 'Add delivery')])).toBe('Add table booking. Add delivery.');
  });
});
