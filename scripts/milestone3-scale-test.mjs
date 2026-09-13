/**
 * Layer 3, Milestone 3, Task 3: scale test - a genuinely larger schema (9
 * components, 3x Milestone 2's count, all four domains, two independent
 * real constraints) run through the full generate -> assemble -> install ->
 * build -> Blueprint verification loop, with wall-clock timing measured
 * rather than estimated, per this project's own established practice.
 *
 * Usage:
 *   node scripts/milestone3-scale-test.mjs
 */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { loadEnvFile } from '../dist/llm/env-file.js';
import { chooseProvider, createProvider } from '../dist/llm/select-provider.js';
import { loadLabelCache } from '../dist/llm/cache.js';
import { buildScaleTestSchema } from '../dist/generate/generate-project.js';
import { generateAndVerifyProject } from '../dist/generate/verify-and-regenerate.js';

loadEnvFile(process.cwd());

const sessionId = randomUUID();
const root = join(process.cwd(), 'generated', sessionId);

console.log(`--- Milestone 3 Task 3: scale test, generating into ${root} ---`);

const choice = chooseProvider(process.env);
const provider = await createProvider(choice);
if (provider === null) {
  console.error(`No API key found for provider "${choice.provider}" (expected ${choice.keyEnv}).`);
  process.exit(1);
}
console.log(`--- using ${choice.provider} provider (${provider.model}) ---`);

const cache = await loadLabelCache(process.cwd());

const schema = buildScaleTestSchema(sessionId, 'milestone-3-scale-test-fixture');
const totalComponents =
  schema.domains.frontend.components.length +
  schema.domains.backend.components.length +
  schema.domains.database.components.length +
  schema.domains.security.components.length;
console.log(`--- ProjectSchema: ${totalComponents} components across all 4 domains, ${schema.constraints.length} constraints ---`);
console.log(JSON.stringify(schema, null, 2));

const wallClockStart = Date.now();
const generationStart = Date.now();
const result = await generateAndVerifyProject(schema, { provider, cache, root });
const generationAndVerifyMs = Date.now() - generationStart;
await cache.flush();

if (!result.ok) {
  console.error('--- generateAndVerifyProject FAILED ---');
  console.error(JSON.stringify(result.error, null, 2));
  process.exit(1);
}

console.log(`\n--- generation + assembly + verification (incl. any retries) succeeded in ${generationAndVerifyMs}ms ---`);
console.log(`  files generated: ${result.value.files.length}`);

console.log('\n=== REGENERATION AUDIT LOG ===');
if (result.value.regenerationLog.length === 0) {
  console.log('  (empty - every component passed Blueprint verification on its first attempt)');
} else {
  for (const attempt of result.value.regenerationLog) {
    console.log(`\n  Component: ${attempt.component.name} (${attempt.domain}) -> ${attempt.targetPath}`);
    console.log(`    Rule violated: ${attempt.firstAttemptViolation.ruleText}`);
    for (const e of attempt.firstAttemptViolation.evidence) console.log(`    Evidence: ${e.file}:${e.line}: ${e.snippet}`);
    console.log(`    Outcome: ${attempt.outcome.toUpperCase()}`);
  }
}

console.log('\n=== UNRESOLVED VIOLATIONS (hard-failed review items) ===');
if (result.value.unresolvedViolations.length === 0) {
  console.log('  (none)');
} else {
  for (const v of result.value.unresolvedViolations) console.log(`  ${v.kind} (${v.severity}): ${v.explanation}`);
}

console.log('\n=== generated file list ===');
for (const file of result.value.files) console.log(`  ${file.path} (${Buffer.byteLength(file.contents, 'utf8')} bytes)`);

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: true, stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

console.log('\n--- npm install ---');
const installStart = Date.now();
const installCode = await run('npm', ['install', '--no-audit', '--no-fund'], root);
const installMs = Date.now() - installStart;
console.log(installCode === 0 ? `  install: PASSED (${installMs}ms)` : `  install: FAILED (exit ${installCode}, ${installMs}ms)`);
if (installCode !== 0) process.exit(1);

console.log('--- npm run build (tsc) ---');
const buildStart = Date.now();
const buildCode = await run('npm', ['run', 'build'], root);
const buildMs = Date.now() - buildStart;
console.log(buildCode === 0 ? `  build: PASSED (${buildMs}ms)` : `  build: FAILED (exit ${buildCode}, ${buildMs}ms)`);
// Deliberately NOT exiting on a build failure: Blueprint parses with
// tree-sitter, not tsc, so a type error does not block checking whether the
// derived graph matches what was generated and whether both constraints
// were evaluated - those are still real, answerable questions even when
// the build itself failed, and Task 3 asks for both regardless.

// Re-run the pipeline one final time, independently of generateAndVerifyProject's
// own internal checks, purely to report (a) parses / (b) graph match / (d)
// both constraints evaluated - the same three claims Milestones 1 and 2 reported,
// now against the larger, final, retried output.
const { runPipeline } = await import('../dist/pipeline/run.js');
const { writeFile } = await import('node:fs/promises');
const blueprintPath = join(root, 'final-verify.blueprint');
await writeFile(blueprintPath, schema.constraints.map((c) => c.rawText).join('\n') + '\n', 'utf8');

console.log('\n--- final independent Blueprint verification ---');
const verifyStart = Date.now();
const finalRun = await runPipeline({ root, blueprintFile: blueprintPath });
const verifyMs = Date.now() - verifyStart;

if (!finalRun.ok) {
  console.error(`Blueprint pipeline FAILED: ${finalRun.error.message}`);
  process.exit(1);
}

const { analysis, conformance } = finalRun.value;

console.log(`--- (a) parses without crashing (${verifyMs}ms) ---`);
console.log(`  files walked: ${analysis.walk.files.length}, parse errors: ${analysis.walk.stats.errors.length}`);
console.log(`  graph: ${analysis.graph.graph.order} nodes, ${analysis.graph.graph.size} edges`);

console.log('--- (b) derived files ---');
for (const file of analysis.walk.files) console.log(`  ${file.path}`);

console.log('--- (d) constraint evaluation summary ---');
console.log(JSON.stringify(conformance.summary, null, 2));
console.log('--- per-constraint verdicts ---');
// Matched by rawText, not id: the constraint objects here come from
// buildScaleTestSchema's own compile call (location: the fixture label),
// while runPipeline recompiles the same DSL text fresh from
// final-verify.blueprint (location: that file's real path) - both content-
// derived ids include `location`, so the two ids differ even though the
// rule itself is identical. rawText is the stable, correct join key.
for (const constraint of schema.constraints) {
  const violated = conformance.violations.some((v) => v.constraint.rawText === constraint.rawText);
  const unchecked = conformance.unchecked.some((u) => u.constraint.rawText === constraint.rawText);
  const verdict = unchecked ? 'UNCHECKED' : violated ? 'VIOLATED' : 'SATISFIED';
  console.log(`  ${constraint.rawText} -> ${verdict}`);
}
if (conformance.violations.length > 0) {
  console.log('--- violation detail ---');
  console.log(JSON.stringify(conformance.violations, null, 2));
}

finalRun.value.db.close();

const totalWallClockMs = Date.now() - wallClockStart;
console.log('\n=== TIMING SUMMARY ===');
console.log(`  generation + assembly + verification (incl. retries): ${generationAndVerifyMs}ms`);
console.log(`  npm install: ${installMs}ms`);
console.log(`  npm run build: ${buildMs}ms`);
console.log(`  final independent Blueprint verification: ${verifyMs}ms`);
console.log(`  TOTAL wall clock: ${totalWallClockMs}ms`);

console.log('\n--- Milestone 3 Task 3 run complete ---');
