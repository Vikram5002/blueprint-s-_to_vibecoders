/**
 * Held-out generalization eval - validation step.
 *
 * Runs every generated output through the REAL compiled validateProjectSchema
 * - the same function every dataset pair in this repo has been checked
 * against, not a Python port and not a looser check for eval purposes. This
 * is the actual test: training loss says the model learned the training set,
 * this says whether it can produce a structurally valid ProjectSchema for a
 * prompt it never saw.
 *
 * Usage:
 *   npm run build:server
 *   node training/eval/validate-holdout-outputs.mjs training/eval/held-out-outputs.json
 */
import { readFileSync } from 'node:fs';

const dist = new URL('../../dist/', import.meta.url);
const { validateProjectSchema } = await import(new URL('workflow/validate-project-schema.js', dist).href);

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node validate-holdout-outputs.mjs <path-to-held-out-outputs.json>');
  process.exit(1);
}

const results = JSON.parse(readFileSync(inputPath, 'utf-8'));
console.log(`Loaded ${results.length} generated outputs from ${inputPath}\n`);

let passed = 0;
let failed = 0;

for (const [index, { prompt, generatedText }] of results.entries()) {
  console.log(`--- [${index + 1}/${results.length}] ${prompt.slice(0, 70)}${prompt.length > 70 ? '...' : ''}`);

  let candidate;
  try {
    candidate = JSON.parse(generatedText);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL: generated text is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    console.log(`  raw output (first 200 chars): ${generatedText.slice(0, 200)}`);
    continue;
  }

  const result = validateProjectSchema(candidate);
  if (result.ok) {
    passed += 1;
    console.log('  PASS: valid ProjectSchema');
  } else {
    failed += 1;
    console.log(`  FAIL: ${result.error.length} violation(s):`);
    for (const rejection of result.error) {
      console.log(`    - ${rejection.path}: ${rejection.reason}`);
    }
  }
  console.log('');
}

console.log(`=== Held-out generalization result ===`);
console.log(`${passed}/${results.length} generated outputs are valid ProjectSchema JSON.`);
console.log(`${failed}/${results.length} failed - see violations above.`);
