/**
 * Runs one repository's module labelling through two models and prints the
 * labels side by side.
 *
 * The default model was changed to Haiku for cost, on the condition that its
 * names are not meaningfully vaguer than a larger model's. This is the check.
 * It needs ANTHROPIC_API_KEY, which is why it is a script rather than a test.
 *
 * Usage:
 *   node scripts/compare-label-models.mjs <repo> [modelA] [modelB]
 *   node scripts/compare-label-models.mjs . claude-haiku-4-5 claude-sonnet-5
 *
 * Each model gets its own cache namespace (the model is part of the cache key),
 * so running this does not poison the cache for normal runs, and re-running it
 * is free.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url);
const { analyseRepository } = await import(new URL('pipeline/analyse.js', dist).href);
const { labelRepository } = await import(new URL('pipeline/label-repository.js', dist).href);
const { estimateCostUsd } = await import(new URL('llm/pricing.js', dist).href);

const repo = process.argv[2] ?? '.';
const models = [process.argv[3] ?? 'claude-haiku-4-5', process.argv[4] ?? 'claude-sonnet-5'];

if (!process.env['ANTHROPIC_API_KEY']) {
  console.error('ANTHROPIC_API_KEY is not set — this comparison needs a real key.');
  process.exit(1);
}

console.log(`\nAnalysing ${repo} …`);
const analysed = await analyseRepository({ root: repo });
if (!analysed.ok) {
  console.error(`analysis failed: ${analysed.error.message}`);
  process.exit(1);
}
const { clustering, parse } = analysed.value;
console.log(`${clustering.modules.length} modules.\n`);

const runs = [];
for (const model of models) {
  // Isolated cache dir per run so a warm cache can't silently answer for the
  // model under test.
  const scratch = mkdtempSync(join(tmpdir(), 'vibe-compare-'));
  const started = Date.now();
  try {
    const labels = await labelRepository({
      root: scratch,
      clustering,
      files: parse.files,
      env: { ...process.env, VIBE_LLM_MODEL: model },
    });
    runs.push({ model, labels, ms: Date.now() - started });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const [a, b] = runs;
const width = 42;
const pad = (text) => String(text ?? '').slice(0, width).padEnd(width);

console.log(`  ${pad(a.model)}  ${pad(b.model)}  mechanical`);
console.log(`  ${'-'.repeat(width)}  ${'-'.repeat(width)}  ----------`);

let differing = 0;
for (const module of clustering.modules) {
  const left = a.labels.labels.get(module.id);
  const right = b.labels.labels.get(module.id);
  if (left?.label !== right?.label) differing += 1;
  console.log(`  ${pad(left?.label)}  ${pad(right?.label)}  ${module.label}`);
}

console.log('');
for (const run of runs) {
  const { usage, cacheMisses, failures } = run.labels.summary;
  console.log(
    `  ${run.model.padEnd(22)} ` +
      `$${usage.estimatedCostUsd.toFixed(4)}  ` +
      `${usage.promptTokens} in / ${usage.completionTokens} out  ` +
      `${cacheMisses} calls  ${failures.length} failed  ${run.ms} ms`,
  );
}
console.log(`\n  ${differing} of ${clustering.modules.length} labels differ between the two models.`);

// Crude but useful: shorter, more generic names are the failure mode to watch for.
for (const run of runs) {
  const names = [...run.labels.labels.values()].map((l) => l.label);
  const words = names.reduce((sum, n) => sum + n.split(/\s+/).length, 0) / Math.max(1, names.length);
  const unique = new Set(names).size;
  console.log(
    `  ${run.model.padEnd(22)} mean ${words.toFixed(2)} words/label, ${unique}/${names.length} distinct`,
  );
}
console.log('');
void estimateCostUsd;
