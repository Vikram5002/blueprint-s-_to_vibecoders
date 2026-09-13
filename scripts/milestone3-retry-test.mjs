/**
 * Layer 3, Milestone 3, Task 2: real end-to-end run of the auto-regeneration
 * retry, against a schema DESIGNED to trigger it - Milestone 1's own
 * task-tracker fixture, whose AuthMiddleware component already has exactly
 * the tension Task 2 asks for (a security component whose stated purpose
 * requires calling a function defined in a domain a constraint forbids it
 * from importing). Reused rather than re-invented: this is the same
 * fixture that produced a real, unforced violation in Milestone 1 - now run
 * through generateAndVerifyProject instead of the old, retry-less
 * generateMilestone1Project, to see whether the retry loop can actually fix
 * what Milestone 1 could only detect.
 *
 * Usage:
 *   node scripts/milestone3-retry-test.mjs
 */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { loadEnvFile } from '../dist/llm/env-file.js';
import { chooseProvider, createProvider } from '../dist/llm/select-provider.js';
import { loadLabelCache } from '../dist/llm/cache.js';
import { buildMilestone1Schema } from '../dist/generate/generate-project.js';
import { generateAndVerifyProject } from '../dist/generate/verify-and-regenerate.js';

loadEnvFile(process.cwd());

const sessionId = randomUUID();
const root = join(process.cwd(), 'generated', sessionId);

console.log(`--- Milestone 3 Task 2: retry test, generating into ${root} ---`);

const choice = chooseProvider(process.env);
const provider = await createProvider(choice);
if (provider === null) {
  console.error(`No API key found for provider "${choice.provider}" (expected ${choice.keyEnv}).`);
  process.exit(1);
}
console.log(`--- using ${choice.provider} provider (${provider.model}) ---`);

const cache = await loadLabelCache(process.cwd());

const schema = buildMilestone1Schema(sessionId, 'milestone-3-retry-test-fixture');
console.log('--- ProjectSchema (Milestone 1\'s fixture, reused for its known tension) ---');
console.log(JSON.stringify(schema, null, 2));

const started = Date.now();
const result = await generateAndVerifyProject(schema, { provider, cache, root });
const elapsedMs = Date.now() - started;
await cache.flush();

if (!result.ok) {
  console.error('--- generateAndVerifyProject FAILED ---');
  console.error(JSON.stringify(result.error, null, 2));
  process.exit(1);
}

console.log(`--- generateAndVerifyProject succeeded in ${elapsedMs}ms ---`);
console.log(`  files: ${result.value.files.length}`);

console.log('\n=== REGENERATION AUDIT LOG ===');
if (result.value.regenerationLog.length === 0) {
  console.log('  (empty - every component passed Blueprint verification on its first attempt)');
} else {
  for (const attempt of result.value.regenerationLog) {
    console.log(`\n  Component: ${attempt.component.name} (${attempt.domain})`);
    console.log(`  Target file: ${attempt.targetPath}`);
    console.log(`  First-attempt violation:`);
    console.log(`    Rule violated: ${attempt.firstAttemptViolation.ruleText}`);
    console.log(`    Explanation: ${attempt.firstAttemptViolation.explanation}`);
    for (const e of attempt.firstAttemptViolation.evidence) {
      console.log(`    Evidence: ${e.file}:${e.line}: ${e.snippet}`);
    }
    console.log(`  Second-attempt outcome: ${attempt.outcome.toUpperCase()}`);
  }
}

console.log('\n=== UNRESOLVED VIOLATIONS (hard-failed review items) ===');
if (result.value.unresolvedViolations.length === 0) {
  console.log('  (none)');
} else {
  for (const v of result.value.unresolvedViolations) {
    console.log(`  ${v.kind} (${v.severity}): ${v.explanation}`);
  }
}

console.log('\n=== final generated files ===');
for (const file of result.value.files) {
  console.log(`\n--- ${file.path} ---`);
  console.log(file.contents);
}

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: true, stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

console.log('\n--- coherence check: npm install ---');
const installCode = await run('npm', ['install', '--no-audit', '--no-fund'], root);
console.log(installCode === 0 ? '  install: PASSED' : `  install: FAILED (exit ${installCode})`);

console.log('--- coherence check: npm run build (tsc) ---');
const buildCode = await run('npm', ['run', 'build'], root);
console.log(buildCode === 0 ? '  build: PASSED' : `  build: FAILED (exit ${buildCode})`);

console.log(`\n--- Milestone 3 Task 2 run complete (${elapsedMs}ms) ---`);
console.log(`  coherence: install=${installCode === 0 ? 'pass' : 'FAIL'} build=${buildCode === 0 ? 'pass' : 'FAIL'}`);
