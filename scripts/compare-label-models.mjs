/**
 * Runs one repository's module labelling through several models and prints the
 * labels side by side.
 *
 * Originally a two-model Anthropic check. Now spans providers, because the
 * default moved to Gemini for cost and the same question applies: are the
 * cheaper model's names meaningfully vaguer? That is not answerable from a
 * price list.
 *
 * Needs whichever key the models under test require, which is why this is a
 * script and not a test. Reads .env, and never prints a key.
 *
 * Usage:
 *   node scripts/compare-label-models.mjs <repo>
 *   node scripts/compare-label-models.mjs . gemini-3.5-flash claude-haiku-4-5
 *
 * Each model runs against its own cache directory, so a warm cache cannot
 * answer for the model under test and normal runs are left untouched.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url);
const { analyseRepository } = await import(new URL('pipeline/analyse.js', dist).href);
const { labelRepository } = await import(new URL('pipeline/label-repository.js', dist).href);
const { isFreeModel } = await import(new URL('llm/pricing.js', dist).href);
const { loadEnvFile } = await import(new URL('llm/env-file.js', dist).href);

loadEnvFile(process.cwd());

const repo = process.argv[2] ?? '.';
const requested = process.argv.slice(3);
const models = requested.length > 0 ? requested : ['gemini-3.5-flash', 'claude-haiku-4-5', 'claude-sonnet-5'];

/** Which vendor a model string belongs to, and therefore which key it needs. */
function providerOf(model) {
  return model.startsWith('gemini') ? 'gemini' : 'anthropic';
}

const KEY_ENV = { gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };

// Skip rather than abort: comparing the two models you *can* run beats
// refusing because a third key is missing.
const runnable = [];
for (const model of models) {
  const env = KEY_ENV[providerOf(model)];
  if (process.env[env]) runnable.push(model);
  else console.error(`  skipping ${model}: ${env} is not set`);
}

if (runnable.length === 0) {
  console.error('\nNo model can run — set GEMINI_API_KEY or ANTHROPIC_API_KEY.');
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
for (const model of runnable) {
  const scratch = mkdtempSync(join(tmpdir(), 'vibe-compare-'));
  const started = Date.now();
  try {
    const labels = await labelRepository({
      root: scratch,
      clustering,
      files: parse.files,
      env: {
        ...process.env,
        VIBE_LLM_PROVIDER: providerOf(model),
        VIBE_LLM_MODEL: model,
      },
    });
    runs.push({ model, labels, ms: Date.now() - started });
  } catch (cause) {
    // One provider failing must not lose the other's results.
    console.error(`  ${model} failed: ${String(cause).slice(0, 160)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (runs.length === 0) {
  console.error('Every model failed.');
  process.exit(1);
}

const width = Math.max(18, Math.floor(96 / runs.length));
const pad = (text) => String(text ?? '—').slice(0, width).padEnd(width);

console.log(`  ${runs.map((run) => pad(run.model)).join('  ')}  mechanical`);
console.log(`  ${runs.map(() => '-'.repeat(width)).join('  ')}  ----------`);

for (const module of clustering.modules) {
  const cells = runs.map((run) => pad(run.labels.labels.get(module.id)?.label));
  console.log(`  ${cells.join('  ')}  ${module.label}`);
}

console.log('\n  cost and usage');
for (const run of runs) {
  const { usage, cacheMisses, failures } = run.labels.summary;
  // Free models report $0 — but tokens are still shown, because they are the
  // number that predicts what a paid provider would charge for the same work.
  const cost = isFreeModel(run.model) ? 'free' : `$${usage.estimatedCostUsd.toFixed(4)}`;
  console.log(
    `    ${run.model.padEnd(22)} ${cost.padStart(8)}  ` +
      `${String(usage.promptTokens).padStart(6)} in / ${String(usage.completionTokens).padStart(6)} out  ` +
      `${String(cacheMisses).padStart(3)} calls  ${failures.length} failed  ${String(run.ms).padStart(6)} ms`,
  );
}

console.log('\n  naming quality');
for (const run of runs) {
  const names = [...run.labels.labels.values()]
    .filter((label) => label.source === 'llm')
    .map((label) => label.label);

  if (names.length === 0) {
    console.log(`    ${run.model.padEnd(22)} no model-supplied labels`);
    continue;
  }

  // Vaguer naming shows up as shorter and more repetitive: a model that falls
  // back on "Core Utilities" for everything scores low on both counts.
  const words = names.reduce((sum, name) => sum + name.split(/\s+/).length, 0) / names.length;
  const distinct = new Set(names).size;
  const echoesPath = names.filter((name, index) => {
    const mechanical = clustering.modules[index]?.label ?? '';
    return mechanical.toLowerCase().includes(name.toLowerCase().replace(/\s+/g, ''));
  }).length;

  console.log(
    `    ${run.model.padEnd(22)} mean ${words.toFixed(2)} words  ` +
      `${distinct}/${names.length} distinct  ${echoesPath} echo the path`,
  );
}

if (runs.length > 1) {
  const [first, ...rest] = runs;
  for (const other of rest) {
    let differing = 0;
    for (const module of clustering.modules) {
      if (first.labels.labels.get(module.id)?.label !== other.labels.labels.get(module.id)?.label) differing += 1;
    }
    console.log(
      `\n  ${differing} of ${clustering.modules.length} labels differ between ${first.model} and ${other.model}.`,
    );
  }
}
console.log('');
