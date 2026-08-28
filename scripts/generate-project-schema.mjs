/**
 * Manual test harness for Layer 2's prompt -> ProjectSchema generator.
 *
 * No HTTP API exists for this yet (see src/workflow/generate-project-schema.ts).
 * This is a direct function call against a real provider, for eyeballing
 * output on a real prompt before any API surface exists.
 *
 * Provider selection reuses select-provider.ts's existing env-based logic
 * (VIBE_LLM_PROVIDER / VIBE_LLM_MODEL, same as every other LLM call site in
 * this project) so this script picks a provider the exact same way the rest
 * of the codebase does. Pass --local to talk to a local_inference_server.py
 * instance instead - this script never starts one itself.
 *
 * Usage:
 *   node scripts/generate-project-schema.mjs "A dice roller for tabletop games."
 *   node scripts/generate-project-schema.mjs --local "A dice roller for tabletop games."
 *   node scripts/generate-project-schema.mjs --local=http://127.0.0.1:8712 "..."
 */
import { loadEnvFile } from '../dist/llm/env-file.js';
import { chooseProvider, createProvider } from '../dist/llm/select-provider.js';
import { createLocalProvider } from '../dist/llm/local.js';
import { loadLabelCache } from '../dist/llm/cache.js';
import { analyzePrompt, createProjectSchemaGenerator } from '../dist/workflow/generate-project-schema.js';

loadEnvFile(process.cwd());

const args = process.argv.slice(2);
const localArg = args.find((a) => a === '--local' || a.startsWith('--local='));
const promptArgs = args.filter((a) => a !== localArg);
const prompt = promptArgs.join(' ').trim();

if (!prompt) {
  console.error('Usage: node scripts/generate-project-schema.mjs [--local[=baseUrl]] "<prompt>"');
  process.exit(1);
}

const analysis = analyzePrompt(prompt);
console.log('--- prompt analysis (heuristic, advisory only) ---');
console.log(`word count: ${analysis.wordCount}`);
console.log(`flags: ${analysis.flags.length > 0 ? analysis.flags.join(', ') : '(none)'}`);
console.log();

let provider;
if (localArg) {
  const baseUrl = localArg.includes('=') ? localArg.slice('--local='.length) : undefined;
  provider = createLocalProvider(baseUrl ? { baseUrl } : {});
  console.log(`--- using local provider (${provider.model}) ---`);
} else {
  const choice = chooseProvider(process.env);
  provider = await createProvider(choice);
  if (provider === null) {
    console.error(`No API key found for provider "${choice.provider}" (expected ${choice.keyEnv}).`);
    console.error('Set that env var, choose a different VIBE_LLM_PROVIDER, or pass --local for a local server.');
    process.exit(1);
  }
  console.log(`--- using ${choice.provider} provider (${provider.model}) ---`);
}

const cache = await loadLabelCache(process.cwd());
const generator = createProjectSchemaGenerator({ provider, cache });

const result = await generator.generate(prompt);
await cache.flush();

if (!result.ok) {
  console.error(`generation failed: ${result.error.reason}`);
  console.error(result.error.message);
  if (result.error.reason === 'schema-violation') {
    for (const rejection of result.error.rejections) {
      console.error(`  ${rejection.path}: ${rejection.reason}`);
    }
  }
  process.exit(1);
}

console.log(JSON.stringify(result.value, null, 2));
