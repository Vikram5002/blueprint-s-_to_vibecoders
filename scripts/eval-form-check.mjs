#!/usr/bin/env node
/**
 * The form check (src/generate/form-check.ts) and its fix loop
 * (src/generate/form-repair.ts) over a folder of built reference projects.
 *
 * For each project that passed its reference build: copy it to scratch,
 * run the form check, and when it finds problems let the repair model fix
 * the pages (form-repair.ts, up to MAX_FORM_FIX_ROUNDS). Records how many
 * page calls each project has, how many work before and after, and what is
 * still wrong.
 *
 * Usage (after npm run build:server):
 *   node scripts/eval-form-check.mjs --reference=capture/code/new-reference \
 *     --gold=training/data/eval-new/plans-563.jsonl --repair=<url>,model=<name> --out=training/eval/forms/<name>.json
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runFormCheck } from '../dist/generate/form-check.js';
import { checkFormsAndRepair } from '../dist/generate/form-repair.js';
import { createLocalProvider } from '../dist/llm/local.js';
import { validateProjectSchema } from '../dist/workflow/validate-project-schema.js';

const arg = (name) => process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const referenceDir = arg('reference') ?? 'capture/code/new-reference';
const goldPath = arg('gold') ?? 'training/data/eval-new/plans-563.jsonl';
const outPath = arg('out') ?? 'training/eval/forms/form-check.json';
const repairSpec = arg('repair');
if (repairSpec === undefined) {
  console.error('usage: --repair=<url>,model=<name> is required');
  process.exit(1);
}
const [repairUrl, ...rest] = repairSpec.split(',');
const repairModel = rest.find((p) => p.startsWith('model='))?.slice('model='.length);
const provider = createLocalProvider({ baseUrl: repairUrl.replace(/\/+$/, ''), ...(repairModel ? { model: repairModel } : {}) });
const nullCache = { get: () => undefined, set: () => {}, flush: async () => true, size: 0 };
const workRoot = resolve(arg('work') ?? 'capture/code/work/eval-form-check');

const rows = [];
for (const line of readFileSync(goldPath, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  const validated = validateProjectSchema(JSON.parse(line).schema);
  if (!validated.ok) continue;
  const schema = validated.value;
  const source = join(referenceDir, schema.sessionId);
  const manifestPath = join(source, 'manifest.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest.passed) continue;

  // A scratch copy, so fixes never touch the reference; node_modules is linked, dist copied.
  const root = join(workRoot, schema.sessionId);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(source, root, { recursive: true, filter: (from) => !from.includes('node_modules') });
  if (existsSync(join(source, 'node_modules'))) symlinkSync(resolve(source, 'node_modules'), join(root, 'node_modules'), 'junction');
  const files = manifest.files.map((path) => ({ path, contents: readFileSync(join(root, ...path.split('/')), 'utf8') }));

  const t0 = Date.now();
  const before = await runFormCheck(root, schema, files);
  const row = { sessionId: schema.sessionId, title: schema.title, calls: before.calls.length, passedBefore: before.passed, problemsBefore: before.problems };
  if (before.problems.length > 0) {
    const repaired = await checkFormsAndRepair({ schema, llm: { provider, repairProvider: provider, cache: nullCache }, root, files });
    if (repaired.ok) {
      row.passedAfter = repaired.value.forms.passed;
      row.problemsAfter = repaired.value.forms.problems;
      row.fixes = repaired.value.regenerationLog.map((a) => ({ page: a.targetPath, outcome: a.outcome }));
    } else {
      row.error = repaired.error.failure ?? repaired.error;
    }
  } else {
    row.passedAfter = before.passed;
    row.problemsAfter = [];
  }
  row.seconds = Math.round((Date.now() - t0) / 1000);
  rows.push(row);
  console.log(`${schema.sessionId} calls ${row.calls} problems ${before.problems.length} -> ${row.problemsAfter?.length ?? '?'} (${row.seconds}s)`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ reference: referenceDir, repairModel: provider.model, rows }, null, 1));
}

const sum = (key) => rows.reduce((s, r) => s + (Array.isArray(r[key]) ? r[key].length : r[key] ?? 0), 0);
console.log('\n--- results ---');
console.log(`projects ${rows.length}; page calls ${sum('calls')}`);
console.log(`projects with a broken call: before ${rows.filter((r) => r.problemsBefore.length > 0).length}, after ${rows.filter((r) => (r.problemsAfter?.length ?? 1) > 0).length}`);
console.log(`broken calls: before ${sum('problemsBefore')}, after ${sum('problemsAfter')}`);
