/**
 * Planner training set, round 2: the existing rows plus complete plans the
 * teacher wrote with scripts/capture-schema-batch.mjs --rich.
 *
 * A row is exactly what training/formatted/dataset.jsonl already holds:
 *   { system: <the one planner system prompt>, user: <the person's prompt>, assistant: JSON.stringify(schema) }
 * (verified 232/232 against the source pairs). The system prompt is copied
 * from the existing rows, so new and old rows match byte for byte.
 *
 * A captured plan is kept only when it is a complete first version - at least
 * three pages, an API and a database, with each page's purpose naming what it
 * shows or lets a person do - because a thin plan teaches the small planner
 * nothing it does not already do.
 *
 * Usage:
 *   node training/format-planner-dataset.mjs --base=training/formatted/dataset.jsonl \
 *     --out=training/formatted-r2/dataset.jsonl capture/planner-r2-w*.jsonl
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { completeDomainDependencies } from '../dist/workflow/complete-dependencies.js';

const args = process.argv.slice(2);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const basePath = value('base') ?? 'training/formatted/dataset.jsonl';
const outPath = value('out') ?? 'training/formatted-r2/dataset.jsonl';
const inputs = args.filter((a) => !a.startsWith('--'));

const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));

const base = readJsonl(basePath);
const systems = new Set(base.map((row) => row.system));
if (systems.size !== 1) throw new Error(`expected one system prompt in ${basePath}, found ${systems.size}`);
const [system] = systems;

/** Why a captured plan is not worth teaching, or [] when it is. */
export function thinPlanReasons(schema) {
  const pages = schema.domains.frontend.components;
  const reasons = [];
  if (pages.length < 3) reasons.push('fewer-than-3-pages');
  if (schema.domains.backend.components.length === 0) reasons.push('no-api');
  if (schema.domains.database.components.length === 0) reasons.push('no-database');
  if (pages.some((page) => page.purpose.split(/\s+/).length < 6)) reasons.push('vague-page-purpose');
  return reasons;
}

const seenPrompts = new Set(base.map((row) => row.user));
const added = [];
let linked = 0;
const dropped = {};
for (const path of inputs) {
  for (const record of readJsonl(path)) {
    const reasons = record.schema === null ? [`not-generated:${record.outcome}`] : thinPlanReasons(record.schema);
    if (seenPrompts.has(record.prompt)) reasons.push('duplicate-prompt');
    if (reasons.length > 0) {
      for (const reason of reasons) dropped[reason] = (dropped[reason] ?? 0) + 1;
      continue;
    }
    seenPrompts.add(record.prompt);
    // The same backend -> database link VibeCoder adds to every plan (src/workflow/complete-dependencies.ts),
    // so the planner learns to write it rather than leave it for the safety net.
    const schema = completeDomainDependencies(record.schema);
    if (schema !== record.schema) linked += 1;
    added.push({ system, user: record.prompt, assistant: JSON.stringify(schema) });
  }
}

const rows = [...base, ...added];
const text = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, text);
const pagesPerPlan = added.map((row) => JSON.parse(row.assistant).domains.frontend.components.length);
const manifest = {
  generatedAt: new Date().toISOString(),
  base: { path: basePath, rows: base.length },
  inputs,
  added: added.length,
  backendDatabaseLinksAdded: linked,
  dropped,
  rows: rows.length,
  meanPagesPerAddedPlan: pagesPerPlan.length === 0 ? 0 : Number((pagesPerPlan.reduce((a, b) => a + b, 0) / pagesPerPlan.length).toFixed(2)),
  sha256: createHash('sha256').update(text).digest('hex'),
};
writeFileSync(join(dirname(outPath), 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
