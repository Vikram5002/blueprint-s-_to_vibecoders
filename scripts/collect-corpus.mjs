/**
 * Week 12 corpus collection harness.
 *
 * Runs the full pipeline (labelling + intent extraction + conformance) over the
 * 50-repository corpus in scripts/corpus/repos.json, entirely on the Gemini
 * free tier. Built to survive an 11-22 day, quota-interrupted schedule — see
 * docs/PROVIDERS.md for why that schedule is what it is.
 *
 * ## Checkpoint discipline
 *
 * Same shape as scripts/evaluate-intent.mjs: persisted after every repository,
 * atomically (write to a temp file, rename over the target), so a kill -9 loses
 * at most the repo in flight, never the ones already done. Re-running the same
 * command resumes; it does not repeat work.
 *
 * ## Model rotation
 *
 * Quota is per model (docs/PROVIDERS.md → "Rate limits"). A repo is attempted
 * with the current ring model; if the run comes back with any daily-quota
 * failure in either labelling or intent extraction, the ring advances and the
 * SAME repo is retried under the next model, up to once per model. Only after
 * every model in the ring has failed on daily quota does the harness stop —
 * cleanly, with the state to resume tomorrow, not a crash.
 *
 * ## Clone verification
 *
 * Week 9 found a Windows path-length failure that clones silently short,
 * leaving thousands of files unwritten — a corpus built on that would
 * benchmark a fast, meaningless pass. Every clone's stderr is scanned for the
 * git warnings that failure produces, and the harness refuses to analyse a
 * short clone.
 *
 * ## Clone once per repo, not once per model attempt
 *
 * v1 re-cloned on every ring rotation, because cloning lived inside the same
 * function as the pipeline run. A repo that exhausted all three models paid
 * for three full clones to learn that. Fixed in v2: the clone happens once
 * before the retry loop, and only the pipeline run — the part that actually
 * depends on which model is being tried — repeats. Recorded `done` entries
 * carry `harnessVersion: 2`; an entry with no `harnessVersion` field was
 * produced by v1, so throughput numbers for those repos include redundant
 * clone time that later entries do not. Do not average the two eras
 * together without noting which is which.
 *
 * Usage:
 *   node scripts/collect-corpus.mjs
 *   node scripts/collect-corpus.mjs --limit=5      # first N pending repos only
 *   node scripts/collect-corpus.mjs --restart       # discard the checkpoint
 *   node scripts/collect-corpus.mjs --max-calls=50  # raise the per-repo budget
 *   node scripts/collect-corpus.mjs --target=25     # override the corpus target
 *   node scripts/collect-corpus.mjs --retry-oversized --max-calls=60
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const dist = new URL('../dist/', import.meta.url);

const { loadEnvFile } = await import(new URL('llm/env-file.js', dist).href);
const { runPipeline } = await import(new URL('pipeline/run.js', dist).href);

loadEnvFile(repoRoot);

const args = process.argv.slice(2);
const RESTART = args.includes('--restart');
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.slice('--limit='.length)) : Infinity;
const maxCallsArg = args.find((a) => a.startsWith('--max-calls='));
/**
 * Hard per-repository call budget.
 *
 * Day 1 of collection completed zero repositories: prisma/prisma consumed the
 * entire day's quota across all three models by itself, and because the loop
 * breaks on quota exhaustion *before* recording the repo, it left no trace of
 * having done so. A corpus of 25 finished repositories is worth more than six
 * finished and one monster half-done.
 *
 * 35 is chosen against the measured daily ceiling: roughly 20 requests per
 * model per day across a three-model ring is about 60 calls, so a repository
 * needing more than 35 cannot finish alongside anything else and will starve
 * the rest of the day. pyright (46 modules + 2 documents) is the shape this
 * excludes; zod (19 + 5) passes comfortably.
 */
const MAX_CALLS_PER_REPO = maxCallsArg ? Number(maxCallsArg.slice('--max-calls='.length)) : 35;
const targetArg = args.find((a) => a.startsWith('--target='));
const corpusArg = args.find((a) => a.startsWith('--corpus='));
const CORPUS_PATH = corpusArg ? corpusArg.slice('--corpus='.length) : join('scripts', 'corpus', 'repos.json');
const checkpointArg = args.find((a) => a.startsWith('--checkpoint-dir='));

const CORPUS_FILE = JSON.parse(readFileSync(join(repoRoot, CORPUS_PATH), 'utf8'));
/**
 * The corpus is the first `target` entries of an ordered list, not the whole
 * file. Entries past the target are retained as overflow — see the `ordering`
 * block in repos.json — so cutting the target is reversible and the reasoning
 * stays with the data.
 */
const TARGET = targetArg
  ? Number(targetArg.slice('--target='.length))
  : (CORPUS_FILE.target ?? CORPUS_FILE.repos.length);
const CORPUS = CORPUS_FILE.repos.slice(0, TARGET);
const CHECKPOINT_DIR = checkpointArg
  ? join(repoRoot, checkpointArg.slice('--checkpoint-dir='.length))
  : join(repoRoot, '.vibe', 'corpus');
const CHECKPOINT = join(CHECKPOINT_DIR, 'checkpoint.json');
const SCRATCH = join(repoRoot, '.vibe', 'corpus-scratch');

/** Quota is per model, so these are three separate daily budgets to rotate through. */
const MODEL_RING = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];

/** Bumped when the harness's behaviour changes in a way that affects recorded
 *  metrics (see "Clone once per repo" above) — lets old and new checkpoint
 *  entries be told apart after the fact. */
const HARNESS_VERSION = 3;

// ---------- checkpoint ----------

function loadCheckpoint() {
  if (RESTART && existsSync(CHECKPOINT)) rmSync(CHECKPOINT);
  if (!existsSync(CHECKPOINT)) {
    return { startedAt: new Date().toISOString(), ringIndex: 0, repos: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(CHECKPOINT, 'utf8'));
    return { ringIndex: 0, repos: {}, ...parsed };
  } catch {
    return { startedAt: new Date().toISOString(), ringIndex: 0, repos: {} };
  }
}

/** Rename-over-target is atomic on both filesystems this runs on; a checkpoint
 *  written in place would be corrupt if the process died mid-write, which is
 *  exactly the moment it matters most. */
function saveCheckpoint(state) {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  const temporary = `${CHECKPOINT}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
  renameSync(temporary, CHECKPOINT);
}

// ---------- clone ----------

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
  });
}

/**
 * The Week 9 failure mode: Windows MAX_PATH truncation drops files from a
 * clone without failing the clone itself. git's own stderr names it plainly
 * when it happens — "Filename too long" or "unable to create file" — so
 * scanning for those strings is cheap and specific, unlike inferring
 * incompleteness from file counts (which has no reliable expected value).
 */
function cloneLooksShort(stderr) {
  return /filename too long|unable to create file|unable to checkout|cannot create/i.test(stderr);
}

/**
 * Windows marks packed git objects read-only after clone, which turns a plain
 * rmSync into an EPERM instead of a delete. maxRetries/retryDelay are Node's
 * built-in handling for exactly this transient case — force alone (ENOENT
 * tolerance) does not cover it.
 */
function removeDir(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function cloneRepo(entry, targetDir) {
  removeDir(targetDir);
  mkdirSync(dirname(targetDir), { recursive: true });
  const result = await run('git', [
    '-c',
    'core.longpaths=true',
    'clone',
    '--depth',
    '1',
    '--single-branch',
    entry.url,
    targetDir,
  ]);
  if (result.code !== 0) {
    return { ok: false, reason: `clone failed (exit ${result.code}): ${result.stderr.slice(-300)}` };
  }
  if (cloneLooksShort(result.stderr)) {
    return { ok: false, reason: `clone looks short (path-length failure): ${result.stderr.slice(-300)}` };
  }
  if (!existsSync(join(targetDir, '.git'))) {
    return { ok: false, reason: 'clone produced no .git directory' };
  }
  return { ok: true };
}

// ---------- quota detection ----------

function isDailyQuota(reason) {
  return /daily free-tier quota exhausted/i.test(reason ?? '');
}

function hadDailyQuotaFailure(result) {
  const labelFailures = result.labels.summary.failures ?? [];
  const intentFailures = result.intent.failures ?? [];
  return (
    labelFailures.some((f) => isDailyQuota(f.reason)) || intentFailures.some((f) => isDailyQuota(f.reason))
  );
}

// ---------- per-repo run ----------

/**
 * How many model calls this repository would cost, measured before spending any.
 *
 * Runs the pipeline with `useModel: false`, which is the whole deterministic
 * half — walk, parse, resolve, cluster, discover documents — and makes no API
 * request at all. One call is made per module (labelling) and one per document
 * (intent extraction), so those two counts are the budget.
 *
 * Costs a second parse of the repository in CPU time. That is worth paying:
 * the alternative is discovering the size *by* spending a day's quota on it,
 * which is exactly what happened on day 1.
 *
 * Note this cannot be replaced by skipping labelling to save calls. Labels are
 * cosmetic to *clustering* but not to *conformance*: `resolve-subject.ts`
 * tokenises a module's label when matching a prose phrase to a module, so a
 * run with mechanical labels resolves a different set of constraints. Turning
 * labelling off would change the measurement, not just its presentation.
 */
async function estimateCalls(targetDir) {
  const result = await runPipeline({ root: targetDir, useModel: false });
  if (!result.ok) {
    return { ok: false, reason: `${result.error.stage}: ${result.error.message}` };
  }
  const run = result.value;
  run.db.close();

  const modules = run.analysis.clustering.modules.length;
  const documents = run.intent.summary.documents;
  return { ok: true, modules, documents, calls: modules + documents };
}

/**
 * Runs the pipeline against an already-cloned directory. Cloning is the
 * caller's job — this function is called once per model-ring attempt, and a
 * clone is good across all of them, so it must not repeat it.
 */
async function analyseClone(targetDir, model) {
  const env = { ...process.env, VIBE_LLM_PROVIDER: 'gemini', VIBE_LLM_MODEL: model };
  const startedAt = Date.now();
  const result = await runPipeline({ root: targetDir, useModel: true, env });
  const durationMs = Date.now() - startedAt;

  // The pipeline opens .vibe/blueprint.db inside targetDir; on Windows an open
  // handle blocks deletion, so the database must be closed before the clone is
  // removed, not after. Closed here, immediately, even though removal itself
  // now happens once in the caller — an open handle would still block a later
  // retry's own analysis of the same directory.
  if (result.ok) result.value.db.close();

  if (!result.ok) {
    return { status: 'analysis-failed', reason: `${result.error.stage}: ${result.error.message}` };
  }

  const run = result.value;

  if (hadDailyQuotaFailure(run)) {
    return { status: 'quota-exhausted', model };
  }

  const violations = run.conformance.summary;
  const resolution = run.analysis.graph.summary;

  return {
    status: 'done',
    model,
    harnessVersion: HARNESS_VERSION,
    durationMs,
    files: run.analysis.parse.files.length,
    modules: run.analysis.clustering.modules.length,
    resolutionRate: resolution.resolutionRate,
    labelling: {
      cacheHits: run.labels.summary.cacheHits,
      cacheMisses: run.labels.summary.cacheMisses,
      failures: run.labels.summary.failures.length,
    },
    intent: {
      documents: run.intent.summary.documents,
      constraints: run.intent.summary.constraints,
      uncheckable: run.intent.summary.uncheckable,
      incompleteDocuments: run.intent.summary.incompleteDocuments,
      cacheHits: run.intent.usage.cacheHits,
      cacheMisses: run.intent.usage.cacheMisses,
    },
    conformance: {
      constraintsChecked: violations.checked,
      violated: violations.violated,
      satisfied: violations.satisfied,
      unchecked: violations.unchecked,
      // Distinguishes "no rules were stated" from "rules were stated and held".
      noRulesStated: run.intent.summary.constraints === 0,
    },
  };
}

// ---------- main ----------

const state = loadCheckpoint();
mkdirSync(SCRATCH, { recursive: true });

/**
 * Statuses that mean "do not attempt this again".
 *
 * `skipped-oversized` is terminal by default: re-cloning and re-parsing a
 * repository already measured as over budget costs minutes of CPU to reach
 * the same verdict. Raising the budget is the deliberate way to revisit it —
 * `--retry-oversized` alongside a larger `--max-calls`.
 */
const RETRY_OVERSIZED = args.includes('--retry-oversized');
const TERMINAL = RETRY_OVERSIZED ? ['done'] : ['done', 'skipped-oversized'];

const allPending = CORPUS.filter((entry) => !TERMINAL.includes(state.repos[entry.repo]?.status));
const doneCount = CORPUS.filter((entry) => state.repos[entry.repo]?.status === 'done').length;
const skippedCount = CORPUS.filter(
  (entry) => state.repos[entry.repo]?.status === 'skipped-oversized',
).length;
const pending = allPending.slice(0, LIMIT);

console.log(`\n  corpus       ${CORPUS.length} repositories`);
console.log(`  done         ${doneCount}`);
console.log(`  oversized    ${skippedCount} (skipped, budget ${MAX_CALLS_PER_REPO} calls/repo)`);
console.log(`  pending      ${allPending.length} (${pending.length} this run)`);
console.log(`  model ring   ${MODEL_RING.join(' -> ')} (starting at ${MODEL_RING[state.ringIndex % MODEL_RING.length]})\n`);

let stoppedForQuota = false;
const runStartedAt = Date.now();
let completedThisRun = 0;

for (const [index, entry] of pending.entries()) {
  const label = `[${index + 1}/${pending.length}] ${entry.repo}`;
  console.log(label);

  const targetDir = join(SCRATCH, entry.repo.replace('/', '__'));
  console.log(`  clone ${entry.repo} ...`);
  const cloned = await cloneRepo(entry, targetDir);

  let outcome;
  if (!cloned.ok) {
    outcome = { status: 'clone-failed', reason: cloned.reason };
  } else {
    // Budget check first, before a single model call is made.
    const estimate = await estimateCalls(targetDir);

    if (!estimate.ok) {
      outcome = { status: 'analysis-failed', reason: estimate.reason };
      removeDir(targetDir);
    } else if (estimate.calls > MAX_CALLS_PER_REPO) {
      console.log(
        `    skipped-oversized: needs ~${estimate.calls} calls ` +
          `(${estimate.modules} modules + ${estimate.documents} documents), budget is ${MAX_CALLS_PER_REPO}`,
      );
      outcome = {
        status: 'skipped-oversized',
        harnessVersion: HARNESS_VERSION,
        estimatedCalls: estimate.calls,
        modules: estimate.modules,
        documents: estimate.documents,
        budget: MAX_CALLS_PER_REPO,
        reason:
          `estimated ${estimate.calls} model calls (${estimate.modules} modules + ` +
          `${estimate.documents} documents) exceeds the per-repo budget of ${MAX_CALLS_PER_REPO}`,
      };
      removeDir(targetDir);
    } else {
      console.log(`    budget ok: ~${estimate.calls} calls (${estimate.modules} modules + ${estimate.documents} documents)`);
      let attemptsLeft = MODEL_RING.length;
      // One clone serves every model attempt below — only the pipeline run
      // repeats, because only that part depends on which model is being tried.
      do {
        const model = MODEL_RING[state.ringIndex % MODEL_RING.length];
        outcome = await analyseClone(targetDir, model);

        if (outcome.status !== 'quota-exhausted') break;

        console.log(`    ${model}: daily quota exhausted, rotating`);
        state.ringIndex = (state.ringIndex + 1) % MODEL_RING.length;
        attemptsLeft -= 1;
      } while (attemptsLeft > 0);

      removeDir(targetDir);
    }
  }

  if (outcome.status === 'quota-exhausted') {
    console.log(`    all ${MODEL_RING.length} models exhausted on ${entry.repo} — stopping for today`);
    /**
     * Record it before stopping.
     *
     * The previous version broke out of the loop without writing an entry, so
     * the repository that consumed the day's quota left no trace in the
     * checkpoint at all — day 1 finished with an empty `repos` map and no way
     * to tell from it which repository had eaten the budget. The estimate is
     * carried too, so an oversized repo that slipped under the budget is
     * still visible after the fact.
     */
    state.repos[entry.repo] = {
      status: 'quota-exhausted',
      harnessVersion: HARNESS_VERSION,
      checkedAt: new Date().toISOString(),
      criteria: entry.criteria,
      reason: `all ${MODEL_RING.length} models in the ring reported daily quota exhaustion`,
    };
    saveCheckpoint(state);
    stoppedForQuota = true;
    break;
  }

  state.repos[entry.repo] = {
    ...outcome,
    checkedAt: new Date().toISOString(),
    criteria: entry.criteria,
  };
  saveCheckpoint(state);

  if (outcome.status === 'done') {
    completedThisRun += 1;
    console.log(
      `    done  model=${outcome.model}  ${outcome.modules} modules  ` +
        `${outcome.conformance.constraintsChecked} checked  ${outcome.conformance.violated} violated  ` +
        `${(outcome.durationMs / 1000).toFixed(1)}s`,
    );
  } else {
    console.log(`    ${outcome.status}: ${outcome.reason ?? ''}`);
  }
}

// ---------- report ----------

const doneEntries = Object.values(state.repos).filter((r) => r.status === 'done');
// Counted from final state, not the pre-run tally — repositories skipped
// during this very run must count too, or "remaining" overstates the backlog.
const skippedFinal = CORPUS.filter(
  (entry) => state.repos[entry.repo]?.status === 'skipped-oversized',
).length;
const remaining = CORPUS.length - doneEntries.length - skippedFinal;
const elapsedMs = Date.now() - runStartedAt;

// v1 entries (no harnessVersion) re-cloned per model attempt; v2 clones once.
// Mixing them into one throughput average would understate v2's real speed.
const v1Done = doneEntries.filter((r) => r.harnessVersion === undefined);
const v2Done = doneEntries.filter((r) => r.harnessVersion === HARNESS_VERSION);

console.log(`\n=== corpus status ===\n`);
const oversized = Object.entries(state.repos).filter(([, r]) => r.status === 'skipped-oversized');

console.log(`  done          ${doneEntries.length} / ${CORPUS.length}`);
console.log(`  remaining     ${remaining}`);
if (oversized.length > 0) {
  /**
   * Reported as its own line, never folded into "done" or "remaining".
   *
   * A skipped repository is a hole in the corpus with a known cause, and the
   * bias it introduces — toward smaller repositories — has to be visible in
   * the numbers rather than inferred from their absence.
   */
  console.log(`  oversized     ${oversized.length} skipped over the ${MAX_CALLS_PER_REPO}-call budget:`);
  for (const [name, r] of oversized) {
    console.log(`                ${name} (~${r.estimatedCalls} calls: ${r.modules} modules + ${r.documents} docs)`);
  }
}
console.log(`  this session  ${completedThisRun} completed in ${(elapsedMs / 60000).toFixed(1)} min`);
if (v1Done.length > 0) {
  const v1Names = Object.entries(state.repos)
    .filter(([, r]) => r.status === 'done' && r.harnessVersion === undefined)
    .map(([name]) => name);
  console.log(`  harness v1    ${v1Done.length} repo(s) ran under the old clone-per-attempt behaviour:`);
  console.log(`                ${v1Names.join(', ')}`);
}

if (completedThisRun > 0) {
  const minutesPerRepo = elapsedMs / 60000 / completedThisRun;
  console.log(`  throughput    ${minutesPerRepo.toFixed(1)} min/repo (this session, real-world clone+analyse+API time)`);
}
if (v2Done.length > 0) {
  const v2Ms = v2Done.reduce((sum, r) => sum + r.durationMs, 0);
  console.log(`  v2 pipeline   ${(v2Ms / v2Done.length / 1000).toFixed(1)}s avg analysis time (clone time excluded, measured once per repo now)`);
}

if (remaining > 0) {
  console.log(`\n  Re-run the same command to continue.`);
  console.log(`  Checkpoint: ${CHECKPOINT}`);
}

console.log('');
process.exit(stoppedForQuota || remaining > 0 ? 2 : 0);
