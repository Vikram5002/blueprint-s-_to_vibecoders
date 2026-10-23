/**
 * Feature suggestions ("research"): after a plan exists, one extra model call
 * proposes features a real application of this kind usually has but the
 * prompt did not ask for - delivery and table booking for a cafe that only
 * asked for orders. Nothing is added on its own: a person ticks the ones they
 * want, and each chosen suggestion's `change` goes through the ordinary plan
 * revision (revise-plan-prompt.ts), the one prompt -> plan task every planner
 * is built and measured on.
 */
import type { CompletionProvider, CompletionRequest } from '../llm/provider.js';
import { type Result, ok, err } from '../types/result.js';
import { DOMAIN_NAMES, type ValidatedProjectSchema } from '../types/project-schema.js';

export interface FeatureSuggestion {
  /** A short feature name, e.g. "Table booking". */
  readonly title: string;
  /** One sentence on why an application of this kind needs it. */
  readonly why: string;
  /** The plan change to ask for if chosen, in the words revise-plan-prompt.ts appends. */
  readonly change: string;
}

export const MAX_SUGGESTIONS = 8;

export const FEATURE_SUGGESTION_SYSTEM_PROMPT = `You suggest features for a web application that is being planned.
You are given the person's request and the plan made from it (its pages, API
routes, tables and security parts). Think about what a real, successful
application of this kind offers its users and owners, beyond what was asked:
other ways to order or book, delivery, payments, notifications, accounts,
reports, admin tools, reviews, search. Suggest only features that are NOT
already in the plan and that clearly fit this kind of application.

For each suggestion give:
- "title": a short feature name (2 to 5 words)
- "why": one plain sentence on why users or the owner need it
- "change": one sentence asking for it, naming the pages and data it needs,
  e.g. "Add a table booking page where customers pick a date, time and party
  size, stored in a table_bookings table, and a staff page listing bookings."

Give between 4 and ${MAX_SUGGESTIONS} suggestions, most useful first. Reply with exactly one
JSON object: {"suggestions": [{"title": ..., "why": ..., "change": ...}]}.`;

const SUGGESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, why: { type: 'string' }, change: { type: 'string' } },
        required: ['title', 'why', 'change'],
      },
    },
  },
  required: ['suggestions'],
} as const;

/** The plan as the model reads it: each domain's components, one line each. */
export function describePlan(schema: ValidatedProjectSchema): string {
  return DOMAIN_NAMES.flatMap((domain) => {
    const components = schema.domains[domain].components;
    return components.length === 0 ? [] : [`${domain}:`, ...components.map((c) => `- ${c.name}: ${c.purpose}`)];
  }).join('\n');
}

export function suggestionRequest(prompt: string, schema: ValidatedProjectSchema): CompletionRequest {
  return {
    system: FEATURE_SUGGESTION_SYSTEM_PROMPT,
    user: `Request:\n${prompt.trim()}\n\nPlan "${schema.title}":\n${describePlan(schema)}`,
    maxOutputTokens: 1500,
    temperature: 0.4,
    schema: SUGGESTIONS_SCHEMA,
  };
}

const words = (text: string): Set<string> =>
  new Set(text.toLowerCase().match(/[a-z]{4,}/g)?.map((w) => w.replace(/s$/, '')) ?? []);

/** True when every significant word of the title already names a planned component. */
function alreadyPlanned(title: string, schema: ValidatedProjectSchema): boolean {
  const wanted = words(title);
  if (wanted.size === 0) return false;
  return DOMAIN_NAMES.some((domain) =>
    schema.domains[domain].components.some((c) => {
      const have = words(`${c.name} ${c.purpose}`);
      return [...wanted].every((w) => have.has(w));
    }),
  );
}

const clean = (value: unknown): string => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '');

/** Keeps complete, new, distinct suggestions; anything malformed is dropped rather than repaired. */
export function parseSuggestions(text: string, schema: ValidatedProjectSchema): FeatureSuggestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (parsed as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const kept: FeatureSuggestion[] = [];
  for (const item of list) {
    const entry = item as Record<string, unknown>;
    const suggestion = { title: clean(entry.title), why: clean(entry.why), change: clean(entry.change) };
    const key = suggestion.title.toLowerCase();
    if (suggestion.title === '' || suggestion.why === '' || suggestion.change === '' || seen.has(key)) continue;
    if (alreadyPlanned(suggestion.title, schema)) continue;
    seen.add(key);
    kept.push(suggestion);
    if (kept.length === MAX_SUGGESTIONS) break;
  }
  return kept;
}

export async function suggestFeatures(
  provider: CompletionProvider,
  prompt: string,
  schema: ValidatedProjectSchema,
): Promise<Result<FeatureSuggestion[], { readonly message: string }>> {
  const request = suggestionRequest(prompt, schema);
  let result = await provider.complete(request);
  // A model that loops hits the output limit; one more try usually does not (generate-project-schema.ts).
  if (!result.ok && result.error.kind === 'incomplete') result = await provider.complete({ ...request, temperature: 0.7 });
  if (!result.ok) return err({ message: result.error.message });
  const suggestions = parseSuggestions(result.value.text, schema);
  return suggestions.length === 0 ? err({ message: 'the model returned no usable suggestions' }) : ok(suggestions);
}

/** One plan change asking for every chosen suggestion, in the order chosen. */
export function changeForSuggestions(chosen: readonly FeatureSuggestion[]): string {
  return chosen.map((s) => s.change.replace(/[.\s]+$/, '')).join('. ') + '.';
}
