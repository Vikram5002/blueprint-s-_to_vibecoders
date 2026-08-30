/**
 * THROWAWAY DIAGNOSTIC SCRIPT - not production code, no tests, not meant
 * to be committed as permanent infrastructure. Written to answer one
 * question: does compileDomainConstraints actually work when fed a real
 * ProjectSchema from a live orchestrator call, rather than a hand-built
 * fixture? Delete after use.
 *
 * 1. Calls createProjectSchemaGenerator with a real provider and a real
 *    prompt.
 * 2. Feeds the resulting ProjectSchema directly into compileDomainConstraints.
 * 3. Prints schema.constraints AND the resulting Constraint[]/
 *    WorkflowPermission[] to console, and appends one line to a JSON-lines
 *    log - every run's raw data survives, not just the most recent one.
 *    (An earlier version of this script overwrote the same output file
 *    on every run, which meant a claimed result couldn't be verified
 *    after the fact once a later run replaced it - this fixes that.)
 *
 * Each log entry also carries `viaFallbackFired: boolean` - set via
 * generate-project-schema.ts's onViaFallback callback, observed at the
 * exact point the via-null-fallback decision is made, not inferred from
 * the final schema afterward. A logged `via: null` was otherwise
 * structurally indistinguishable from "the model correctly said there
 * was no via" - both produce the same final value, so this is the only
 * way to actually answer "did the fallback ever fire on real output."
 *
 * Usage:
 *   node scripts/pipe-schema-to-compiler.mjs "<prompt>"
 *
 * Log: scratch-pipe-schema-to-compiler-log.jsonl (repo root, one JSON
 * object per line, appended - not overwritten - across runs).
 */
import { appendFileSync } from 'node:fs';
import { loadEnvFile } from '../dist/llm/env-file.js';
import { chooseProvider, createProvider } from '../dist/llm/select-provider.js';
import { loadLabelCache } from '../dist/llm/cache.js';
import { createProjectSchemaGenerator } from '../dist/workflow/generate-project-schema.js';
import { compileDomainConstraints } from '../dist/workflow/compile-constraints.js';

loadEnvFile(process.cwd());

const LOG_PATH = 'scratch-pipe-schema-to-compiler-log.jsonl';

function appendLog(record) {
  appendFileSync(LOG_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n', 'utf8');
}

const prompt = process.argv.slice(2).join(' ').trim();
if (!prompt) {
  console.error('Usage: node scripts/pipe-schema-to-compiler.mjs "<prompt>"');
  process.exit(1);
}

const choice = chooseProvider(process.env);
const provider = await createProvider(choice);
if (provider === null) {
  console.error(`No API key found for provider "${choice.provider}" (expected ${choice.keyEnv}).`);
  process.exit(1);
}
console.log(`--- step 1: generating with ${choice.provider} (${provider.model}) ---`);

const cache = await loadLabelCache(process.cwd());

// Reset per call; fillResolvedSubjectFixedFields calls this synchronously,
// during generate(), whenever it discards a via - regardless of whether
// the schema ends up passing validateProjectSchema overall.
let viaFallbackFired = false;
const generator = createProjectSchemaGenerator({
  provider,
  cache,
  onViaFallback: () => {
    viaFallbackFired = true;
  },
});

const genResult = await generator.generate(prompt);
await cache.flush();

if (!genResult.ok) {
  console.error('generation failed:', genResult.error.reason, genResult.error.message);
  const rejections = genResult.error.reason === 'schema-violation' ? genResult.error.rejections : [];
  for (const r of rejections) console.error(' ', r.path, r.reason);
  appendLog({
    prompt,
    outcome: 'generation-failed',
    reason: genResult.error.reason,
    message: genResult.error.message,
    rejections,
    viaFallbackFired,
  });
  process.exit(1);
}

const schema = genResult.value;
console.log('generation succeeded.');
console.log('sessionId:', schema.sessionId);
console.log('viaFallbackFired:', viaFallbackFired);
console.log('domain keys:', Object.keys(schema.domains));
for (const [name, spec] of Object.entries(schema.domains)) {
  console.log(`  ${name}.dependsOn =`, JSON.stringify(spec.dependsOn));
}

console.log();
console.log(`--- schema.constraints (${schema.constraints.length}) ---`);
console.log(JSON.stringify(schema.constraints, null, 2));

console.log();
console.log('--- step 2: feeding schema.domains directly into compileDomainConstraints ---');

let compiled;
let compileError = null;
try {
  compiled = compileDomainConstraints(schema);
} catch (err) {
  compileError = err;
}

if (compileError) {
  console.error('compileDomainConstraints THREW:', compileError.message);
  appendLog({ prompt, outcome: 'compiler-threw', schema, error: compileError.message, viaFallbackFired });
  process.exit(1);
}

console.log('compileDomainConstraints succeeded.');
console.log('prohibitions:', compiled.prohibitions.length);
console.log('permissions:', compiled.permissions.length);
console.log('total:', compiled.prohibitions.length + compiled.permissions.length, '(expected 12 for 4 domains)');

console.log();
console.log('--- step 3: full compiled output ---');
console.log(JSON.stringify(compiled, null, 2));

appendLog({ prompt, outcome: 'ok', schema, compiled, viaFallbackFired });
console.log();
console.log(`Appended to ${LOG_PATH}`);
