/**
 * Layer 3, Milestone 1: end-to-end run.
 *
 * Builds the fixture ProjectSchema, generates each component's file with a
 * real provider call, assembles the project under generated/<sessionId>/,
 * runs `npm install` + `npm run build` there, writes the milestone's
 * constraint as a blueprint DSL file, and runs the existing, unmodified
 * Blueprint pipeline (`runPipeline`) against the generated directory -
 * exactly as it runs against any other real repository.
 *
 * Usage:
 *   node scripts/milestone1-generate.mjs
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { loadEnvFile } from '../dist/llm/env-file.js';
import { chooseProvider, createProvider } from '../dist/llm/select-provider.js';
import { loadLabelCache } from '../dist/llm/cache.js';
import { buildMilestone1Schema, generateMilestone1Project, MILESTONE_1_CONSTRAINT_DSL } from '../dist/generate/generate-project.js';
import { runPipeline } from '../dist/pipeline/run.js';

loadEnvFile(process.cwd());

const sessionId = randomUUID();
const root = join(process.cwd(), 'generated', sessionId);

console.log(`--- Milestone 1: generating into ${root} ---`);

const choice = chooseProvider(process.env);
const provider = await createProvider(choice);
if (provider === null) {
  console.error(`No API key found for provider "${choice.provider}" (expected ${choice.keyEnv}).`);
  process.exit(1);
}
console.log(`--- using ${choice.provider} provider (${provider.model}) ---`);

const cache = await loadLabelCache(process.cwd());

const schema = buildMilestone1Schema(sessionId, 'milestone-1-fixture');
console.log('--- ProjectSchema ---');
console.log(JSON.stringify(schema, null, 2));

const generated = await generateMilestone1Project(schema, { provider, cache });
await cache.flush();

if (!generated.ok) {
  console.error(`--- component generation FAILED ---`);
  console.error(`component: ${generated.error.component.name} (${generated.error.domain})`);
  console.error(`reason: ${generated.error.failure.reason}`);
  console.error(generated.error.failure.message);
  process.exit(1);
}

console.log(`--- component generation succeeded: ${generated.value.files.length} files ---`);
for (const file of generated.value.files) {
  console.log(`  ${file.path} (${Buffer.byteLength(file.contents, 'utf8')} bytes)`);
}

await rm(root, { recursive: true, force: true });
for (const file of generated.value.files) {
  const fullPath = join(root, ...file.path.split('/'));
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, file.contents, 'utf8');
}

console.log('--- generated files ---');
for (const file of generated.value.files) {
  console.log(`\n=== ${file.path} ===`);
  console.log(file.contents);
}

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: true, stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

console.log('--- npm install ---');
const installCode = await run('npm', ['install', '--no-audit', '--no-fund'], root);
if (installCode !== 0) {
  console.error(`npm install FAILED with exit code ${installCode}`);
  process.exit(1);
}

console.log('--- npm run build (tsc) ---');
const buildCode = await run('npm', ['run', 'build'], root);
if (buildCode !== 0) {
  console.error(`npm run build FAILED with exit code ${buildCode}`);
  process.exit(1);
}
console.log('--- assembly succeeded: install + build both passed ---');

const blueprintPath = join(root, 'milestone1.blueprint');
await writeFile(blueprintPath, `${MILESTONE_1_CONSTRAINT_DSL}\n`, 'utf8');
console.log(`--- wrote blueprint DSL: ${blueprintPath} ---`);
console.log(`  ${MILESTONE_1_CONSTRAINT_DSL}`);

console.log('--- running the existing Blueprint pipeline against the generated directory ---');
const runResult = await runPipeline({ root, blueprintFile: blueprintPath });

if (!runResult.ok) {
  console.error(`Blueprint pipeline FAILED: ${runResult.error.message}`);
  process.exit(1);
}

const { analysis, conformance, blueprintCompile, db } = runResult.value;

console.log('--- (a) parses without crashing ---');
console.log(`  files walked: ${analysis.walk.files.length}, parse errors: ${analysis.walk.stats.errors.length}`);
console.log(`  graph: ${analysis.graph.graph.order} nodes, ${analysis.graph.graph.size} edges`);

console.log('--- derived files ---');
for (const file of analysis.walk.files) console.log(`  ${file}`);

console.log('--- blueprint compile ---');
console.log(JSON.stringify(blueprintCompile, null, 2));

console.log('--- (c) conformance result ---');
console.log(JSON.stringify(conformance, null, 2));

db.close();
console.log('--- Milestone 1 run complete ---');
