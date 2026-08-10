/**
 * Precision and recall for intent extraction, against the hand-labelled set.
 *
 * ## Resumable by construction
 *
 * The free tier throttles, and it throttles daily rather than politely. A run
 * that only wrote its results at the end would lose thirty documents' work to a
 * 429 on the twenty-ninth, and would then need the whole quota again tomorrow
 * to learn anything.
 *
 * So every document is checkpointed the moment it completes, atomically, and a
 * re-run skips whatever is already recorded. Stopping is not failure: the run
 * reports what it has, says which documents remain, and exits so it can be
 * continued. The same shape is what Week 14 will need across 100 repositories,
 * which is the argument for building it while the stakes are 31 documents.
 *
 * Two layers of persistence, doing different jobs. The response cache stops a
 * completed document costing a second API call; the checkpoint stops a
 * completed document costing a second *compile*, and is what makes partial
 * scoring possible.
 *
 * Usage:
 *   node scripts/evaluate-intent.mjs
 *   node scripts/evaluate-intent.mjs --model=gemini-3.5-flash-lite
 *   node scripts/evaluate-intent.mjs --restart     # discard the checkpoint
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const dist = new URL('../dist/', import.meta.url);

const { loadEnvFile } = await import(new URL('llm/env-file.js', dist).href);
const { createGeminiProvider } = await import(new URL('llm/gemini.js', dist).href);
const { createAnthropicProvider } = await import(new URL('llm/anthropic.js', dist).href);
const { createCachedExtractor } = await import(new URL('llm/extract-intent.js', dist).href);
const { loadLabelCache } = await import(new URL('llm/cache.js', dist).href);
const { compileCandidates } = await import(new URL('conformance/compile.js', dist).href);
const { score, formatMatrix } = await import(new URL('conformance/evaluate.js', dist).href);
const { analyseRepository } = await import(new URL('pipeline/analyse.js', dist).href);
const { GOLD, GOLD_CONSTRAINTS } = await import(new URL('conformance/fixtures/intent/gold.js', dist).href);

loadEnvFile(process.cwd());

const args = process.argv.slice(2);
const modelArg = args.find((a) => a.startsWith('--model='));
const MODEL = modelArg ? modelArg.slice('--model='.length) : 'gemini-3.5-flash-lite';
const RESTART = args.includes('--restart');

const FIXTURES = join(repoRoot, 'src', 'conformance', 'fixtures', 'intent');
const CHECKPOINT_DIR = join(repoRoot, '.vibe', 'intent-eval');
const CHECKPOINT = join(CHECKPOINT_DIR, `${MODEL.replace(/[^a-z0-9.-]/gi, '_')}.json`);

/**
 * Which repository each document came from, so subjects resolve against the
 * modules of the project that wrote them. Resolving pyright's prose against
 * this project's modules would be a different and much easier experiment.
 */
const SCRATCH = join(
  'C:',
  'Users',
  'bunny',
  'AppData',
  'Local',
  'Temp',
  'claude',
  'd--project-blue-print',
  '1cdf08f2-fe60-43b9-9fc4-b01e71eaa4e8',
  'scratchpad',
  'repos',
);
const PROJECT_ROOTS = {
  blueprint: repoRoot,
  pyright: join(SCRATCH, 'pyright'),
  requests: join(SCRATCH, 'requests'),
  zod: join(SCRATCH, 'zod'),
};

/**
 * Source type per document, set by hand rather than guessed from the filename.
 *
 * It feeds the confidence score — an agent instruction file is weighted above a
 * README — so getting it wrong would quietly shift every number that depends on
 * it. These four are genuinely files written to instruct a machine.
 */
const AGENT_FILES = new Set([
  'blueprint-claude.md',
  'pyright-copilot-instructions.md',
  'pyright-test-policy.md',
  'pyright-typeshed-agent.md',
]);

function sourceTypeFor(file) {
  if (AGENT_FILES.has(file)) return 'agents-md';
  if (/contributing/i.test(file)) return 'readme';
  return 'readme';
}

function projectFor(file) {
  return file.split('-')[0];
}

// ---------- checkpoint ----------

function loadCheckpoint() {
  if (RESTART && existsSync(CHECKPOINT)) rmSync(CHECKPOINT);
  if (!existsSync(CHECKPOINT)) {
    return { model: MODEL, startedAt: new Date().toISOString(), documents: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(CHECKPOINT, 'utf8'));
    if (parsed.model !== MODEL) {
      // A checkpoint from another model would mix two experiments into one
      // score. Start fresh rather than silently blend them.
      return { model: MODEL, startedAt: new Date().toISOString(), documents: {} };
    }
    return parsed;
  } catch {
    return { model: MODEL, startedAt: new Date().toISOString(), documents: {} };
  }
}

/**
 * Write to a sibling file, then rename over the target.
 *
 * A checkpoint written in place is corrupt if the process dies mid-write, which
 * is exactly the moment it is most needed. Rename is atomic on both filesystems
 * this runs on.
 */
function saveCheckpoint(state) {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  const temporary = `${CHECKPOINT}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
  renameSync(temporary, CHECKPOINT);
}

// ---------- provider ----------

function makeProvider() {
  if (MODEL.startsWith('gemini')) {
    const key = process.env['GEMINI_API_KEY'];
    if (!key) throw new Error('GEMINI_API_KEY is not set');
    return createGeminiProvider({ apiKey: key, model: MODEL });
  }
  const key = process.env['ANTHROPIC_API_KEY'];
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  return createAnthropicProvider({ apiKey: key, model: MODEL });
}

/** A daily quota failure is worth stopping for; a per-minute one is not. */
function isDailyQuota(reason) {
  return /daily free-tier quota exhausted/i.test(reason ?? '');
}

// ---------- run ----------

const state = loadCheckpoint();
const done = new Set(Object.keys(state.documents));
const pending = GOLD.map((entry) => entry.file).filter((file) => !done.has(file));

console.log(`\n  model        ${MODEL}`);
console.log(`  corpus       ${GOLD.length} documents`);
console.log(`  checkpoint   ${done.size} already recorded, ${pending.length} to do`);
if (pending.length === 0) console.log('  (nothing to extract; scoring what is stored)');

const provider = pending.length > 0 ? await makeProvider() : null;
const cache = await loadLabelCache(repoRoot);
const extractor = provider === null ? null : createCachedExtractor({ provider, cache });

// Analysed once per project, not once per document.
const moduleCache = new Map();
async function modulesFor(project) {
  if (moduleCache.has(project)) return moduleCache.get(project);
  const root = PROJECT_ROOTS[project];
  const analysed = await analyseRepository({ root });
  if (!analysed.ok) throw new Error(`cannot analyse ${project}: ${analysed.error.message}`);
  const modules = analysed.value.clustering.modules.map((module) => ({
    moduleId: module.id,
    label: module.label,
    directories: module.directories,
    fileCount: module.files.length,
  }));
  const directories = [...new Set(analysed.value.clustering.modules.flatMap((m) => m.directories))].sort();
  const entry = { modules, directories };
  moduleCache.set(project, entry);
  return entry;
}

let stoppedEarly = false;

for (const [index, file] of pending.entries()) {
  const project = projectFor(file);
  const documentText = readFileSync(join(FIXTURES, file), 'utf8');
  const type = sourceTypeFor(file);

  process.stdout.write(`  [${String(index + 1).padStart(2)}/${pending.length}] ${file.padEnd(34)}`);

  const { modules, directories } = await modulesFor(project);
  const result = await extractor.extract([
    { location: file, documentText, moduleHints: modules.map((m) => m.label).sort() },
  ]);

  if (result.failures.length > 0) {
    const failure = result.failures[0];
    const reason = failure.reason;
    if (isDailyQuota(reason)) {
      // Nothing was recorded for this document, so tomorrow's run picks it up.
      console.log('quota exhausted');
      stoppedEarly = true;
      break;
    }
    /**
     * A truncated document is NOT a zero-constraint document.
     *
     * Recording it as one would fold a budget problem into the recall figure
     * and make the eval quietly wrong — the same silent-zero failure this run
     * exists to rule out. It is marked here and excluded from scoring below,
     * so it is neither a hit nor a miss.
     */
    console.log(`${failure.incomplete ? 'INCOMPLETE' : 'failed'}: ${reason.slice(0, 56)}`);
    state.documents[file] = {
      error: reason,
      incomplete: failure.incomplete === true,
      constraints: [],
      uncheckable: [],
      statements: 0,
    };
    saveCheckpoint(state);
    continue;
  }

  const candidates = result.outcomes[0]?.candidates ?? [];
  const compiled = compileCandidates({
    candidates,
    source: { type, location: file, line: null, timestamp: null },
    documentText,
    modules,
    directories,
  });

  state.documents[file] = {
    statements: candidates.length,
    constraints: compiled.constraints.map((c) => ({
      relation: c.relation,
      subject: c.subject.phrase,
      object: c.object.phrase,
      subjectStatus: c.subject.status,
      objectStatus: c.object.status,
      confidence: c.confidence,
      lowConfidence: c.lowConfidence,
      rawText: c.rawText.slice(0, 160),
    })),
    uncheckable: compiled.uncheckable.map((u) => ({ reason: u.reason, rawText: u.rawText.slice(0, 120) })),
    rejected: compiled.rejected.map((r) => r.reason),
  };

  // Persisted here, immediately, not after the loop.
  saveCheckpoint(state);
  console.log(
    `${String(candidates.length).padStart(2)} stmts  ` +
      `${String(compiled.constraints.length).padStart(2)} constraints  ` +
      `${String(compiled.uncheckable.length).padStart(2)} uncheckable`,
  );
}

await cache.flush();

// ---------- score what exists ----------

// Truncated documents were never read, so they are excluded from scoring
// entirely rather than counted as having produced nothing.
const incomplete = GOLD.filter((entry) => state.documents[entry.file]?.incomplete === true);
const processed = GOLD.filter(
  (entry) => state.documents[entry.file] !== undefined && state.documents[entry.file].incomplete !== true,
);
const processedFiles = new Set(processed.map((entry) => entry.file));

const predicted = [];
for (const entry of processed) {
  for (const constraint of state.documents[entry.file].constraints) {
    predicted.push({
      relation: constraint.relation,
      subject: constraint.subject,
      object: constraint.object,
      file: entry.file,
    });
  }
}

const gold = GOLD_CONSTRAINTS.filter((entry) => processedFiles.has(entry.file));
const documentsWithNoGold = processed.filter((entry) => entry.constraints.length === 0).length;
const matrix = score(predicted, gold, documentsWithNoGold);

if (incomplete.length > 0) {
  console.log(`\n  !! ${incomplete.length} document(s) were cut off at the token limit and are`);
  console.log('     excluded from scoring — they were not read, so they are neither a hit');
  console.log('     nor a miss. Every figure below is over the remainder only.');
  for (const entry of incomplete) console.log(`       ${entry.file}`);
}

console.log(`\n=== precision and recall (${processed.length} of ${GOLD.length} documents) ===\n`);
console.log(formatMatrix(matrix));

// ---------- uncheckable ----------

const byReason = {};
let uncheckableTotal = 0;
let statementsTotal = 0;
let rejectedTotal = 0;
for (const entry of processed) {
  const record = state.documents[entry.file];
  statementsTotal += record.statements ?? 0;
  rejectedTotal += (record.rejected ?? []).length;
  for (const statement of record.uncheckable ?? []) {
    byReason[statement.reason] = (byReason[statement.reason] ?? 0) + 1;
    uncheckableTotal += 1;
  }
}

console.log(`\n=== architectural but uncheckable ===\n`);
console.log(`  statements returned      ${statementsTotal}`);
console.log(`  became constraints       ${predicted.length}`);
console.log(`  uncheckable              ${uncheckableTotal}`);
console.log(`  rejected by validation   ${rejectedTotal}`);
for (const [reason, total] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${reason.padEnd(28)} ${total}`);
}

const lowConfidence = processed.flatMap((e) => state.documents[e.file].constraints).filter((c) => c.lowConfidence);
const unresolved = processed
  .flatMap((e) => state.documents[e.file].constraints)
  .filter((c) => c.subjectStatus === 'UNRESOLVED' || c.objectStatus === 'UNRESOLVED');
console.log(`\n  low confidence           ${lowConfidence.length} of ${predicted.length}`);
console.log(`  with an unresolved role  ${unresolved.length} of ${predicted.length}`);

// ---------- what remains ----------

const remaining = GOLD.map((e) => e.file).filter((file) => state.documents[file] === undefined);
if (remaining.length > 0) {
  console.log(`\n  ${remaining.length} document(s) not yet processed:`);
  for (const file of remaining.slice(0, 8)) console.log(`    ${file}`);
  if (remaining.length > 8) console.log(`    … and ${remaining.length - 8} more`);
  console.log(`\n  Re-run the same command to continue. Progress is in`);
  console.log(`  .vibe/intent-eval/, and completed documents are not re-sent.`);
}

console.log('');
process.exit(stoppedEarly || remaining.length > 0 ? 2 : 0);
