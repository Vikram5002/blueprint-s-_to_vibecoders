#!/usr/bin/env node
/**
 * Training data for feature suggestions (src/workflow/suggest-features.ts),
 * written by the teacher for the planner's own training prompts.
 *
 * For every row of a planner dataset (system/user/assistant, the assistant a
 * ProjectSchema), the teacher is sent exactly suggestionRequest(prompt, plan)
 * - the request the server sends the planner - and its answer is kept only
 * when parseSuggestions keeps at least 4 suggestions (complete, new to the
 * plan, distinct). Output rows are planner-dataset rows (system, user,
 * assistant), so the planner learns to plan and to suggest from one adapter.
 *
 * Usage (after npm run build:server; a teacher served on the local protocol):
 *   node scripts/capture-suggestions.mjs training/formatted-r4/dataset.jsonl --local=http://127.0.0.1:8712 \
 *     --model=teacher --out=training/formatted-suggestions/dataset.jsonl [--concurrency=8]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseSuggestions, suggestionRequest } from '../dist/workflow/suggest-features.js';
import { validateProjectSchema } from '../dist/workflow/validate-project-schema.js';
import { createLocalProvider } from '../dist/llm/local.js';

const args = process.argv.slice(2);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = value('out') ?? 'training/formatted-suggestions/dataset.jsonl';
const provider = createLocalProvider({ baseUrl: value('local') ?? 'http://127.0.0.1:8712', model: value('model') ?? 'teacher' });
const concurrency = Number(value('concurrency') ?? 8);
const input = args.find((a) => !a.startsWith('--'));

const plans = [];
for (const line of readFileSync(input, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  const row = JSON.parse(line);
  let schema;
  try { schema = JSON.parse(row.assistant); } catch { continue; }
  const validated = validateProjectSchema(schema);
  if (validated.ok) plans.push({ prompt: row.user, schema: validated.value });
}
console.log(`${plans.length} valid plans`);

const rows = [];
let next = 0, rejected = 0, failed = 0;
async function worker() {
  while (next < plans.length) {
    const { prompt, schema } = plans[next++];
    const request = suggestionRequest(prompt, schema);
    const result = await provider.complete(request);
    if (!result.ok) { failed++; continue; }
    const suggestions = parseSuggestions(result.value.text, schema);
    if (suggestions.length < 4) { rejected++; continue; }
    rows.push({ system: request.system, user: request.user, assistant: JSON.stringify({ suggestions }) });
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`kept ${rows.length}, rejected ${rejected}, failed ${failed} -> ${out}`);
