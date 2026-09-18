/**
 * Training-data collection for the local code model - docs/LOCAL-CODE-MODEL-PLAN.md §5-6.
 *
 * Same guarantees as capture-schema-batch.mjs, for the same reasons:
 *
 *   - Append-only JSONL, fsync'd per record. Killing the process loses at most
 *     the in-flight project.
 *   - Raw provider text is kept for EVERY teacher call, success or failure, in
 *     a sidecar file next to --out (<out>.raw.jsonl), so a bad batch can be
 *     diagnosed without re-running it.
 *   - The cache is null by construction: every prompt reaches the teacher.
 *   - Resumable: a plan whose sessionId already appears in --out (or in the
 *     per-project sidecar <out>.projects.jsonl, for a project that produced no
 *     component record) is skipped.
 *   - Nothing here re-implements a prompt. Every record's `request` is what the
 *     REAL `generateComponentFile` -> `createComponentCodeGenerator` sent to a
 *     recording stub provider, rebuilt against the FINAL files of the project
 *     (so the prompt describes exactly the dependency code the example is
 *     paired with, even when a dependency was rewritten during repair).
 *
 * The pipeline per plan is exactly the server's: validateProjectSchema ->
 * generateAndVerifyProject (skipCache) -> installBuildAndRepair -> runRuntimeCheck.
 *
 * Usage:
 *   node scripts/capture-code-batch.mjs --local=<url> --model=<served name> --out=capture/code/teacher-batch-1.jsonl
 *       [--sources=training/data/real-project,training/data/synthetic] [--limit=N] [--domains=backend,security]
 *   node scripts/capture-code-batch.mjs --out=... (no --local: the provider chosen by VIBE_LLM_PROVIDER / .env, Gemini by default)
 *
 * training/data/gold is NEVER read here (asserted below): gold is the test set,
 * see training/data/METHODOLOGY.md.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createLocalProvider } from '../dist/llm/local.js';
import { loadEnvFile } from '../dist/llm/env-file.js';
import { validateProjectSchema } from '../dist/workflow/validate-project-schema.js';
import { generateAndVerifyProject, verifyGeneratedProject } from '../dist/generate/verify-and-regenerate.js';
import { installBuildAndRepair } from '../dist/generate/build-and-repair.js';
import { runRuntimeCheck, routeResultsFor } from '../dist/generate/runtime-check.js';
import { detectServiceLocatorEvasion } from '../dist/generate/detect-service-locator-evasion.js';
import { createComponentCodeGenerator } from '../dist/generate/component-codegen.js';
import { generateComponentFile, findComponentByTargetPath } from '../dist/generate/generate-project.js';

loadEnvFile(process.cwd());

// ---- arguments ---------------------------------------------------------------

const args = process.argv.slice(2);
const argValue = (name) => {
  const found = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (found === undefined) return undefined;
  return found.includes('=') ? found.slice(name.length + 3) : '';
};

const outPath = argValue('out');
if (!outPath) {
  console.error(
    'Usage: node scripts/capture-code-batch.mjs [--local=<url>] [--model=<served name>] --out=<path.jsonl> ' +
      '[--sources=dir1,dir2] [--limit=N] [--domains=backend,security] [--work=capture/code/work]',
  );
  process.exit(1);
}

const localUrl = argValue('local');
const modelName = argValue('model');
const limit = argValue('limit') ? Number(argValue('limit')) : Infinity;
const domainFilter = argValue('domains') ? new Set(argValue('domains').split(',').map((d) => d.trim())) : null;
const sources = (argValue('sources') ?? 'training/data/real-project,training/data/synthetic').split(',').map((s) => s.trim()).filter(Boolean);
const workRoot = argValue('work') ?? 'capture/code/work';

const GOLD_DIR = resolve('training/data/gold');
for (const source of sources) {
  const absolute = resolve(source);
  if (absolute === GOLD_DIR || absolute.startsWith(GOLD_DIR + sep)) {
    console.error(`refusing to read ${source}: training/data/gold is the held-out test set and never a training source`);
    process.exit(1);
  }
}

// ---- provider --------------------------------------------------------------

// Training data may only come from an open-weight teacher served locally
// (docs/GEMINI-TERMS-REVIEW.md: Gemini output is never training data), so
// unlike capture-schema-batch.mjs there is NO vendor fallback here - a run
// without --local refuses rather than quietly billing a vendor whose output
// the formatter would then reject anyway.
if (localUrl === undefined) {
  console.error('capture-code-batch.mjs requires --local=<teacher server url>: training data is only ever collected from a locally served open-weight teacher, never from a vendor API.');
  process.exit(1);
}
// `model` is what the server matches against its --model list; it is sent
// in every request body by the local adapter.
const provider = createLocalProvider({ ...(localUrl ? { baseUrl: localUrl.replace(/\/+$/, '') } : {}), ...(modelName ? { model: modelName } : {}) });

// ---- output files ----------------------------------------------------------

mkdirSync(dirname(outPath), { recursive: true });
mkdirSync(workRoot, { recursive: true });
const rawPath = join(dirname(outPath), `${basename(outPath, '.jsonl')}.raw.jsonl`);
const projectsPath = join(dirname(outPath), `${basename(outPath, '.jsonl')}.projects.jsonl`);

/** Append one JSON line and fsync it - the record is on disk before the next provider call starts. */
function writeLine(path, record) {
  const fd = openSync(path, 'a');
  try {
    appendFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readSessionIds(path) {
  if (!existsSync(path)) return new Set();
  const ids = new Set();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.sessionId === 'string') ids.add(parsed.sessionId);
    } catch {
      // A torn last line from a killed run is skipped, not fatal.
    }
  }
  return ids;
}

const done = new Set([...readSessionIds(outPath), ...readSessionIds(projectsPath)]);

// ---- plans -----------------------------------------------------------------

function jsonlFilesUnder(path) {
  if (!existsSync(path)) {
    console.error(`source not found: ${path}`);
    process.exit(1);
  }
  if (statSync(path).isFile()) return [path];
  return readdirSync(path)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => join(path, name));
}

const plans = [];
for (const source of sources) {
  for (const file of jsonlFilesUnder(source)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const pair = JSON.parse(line);
      plans.push({ sourceFile: file.replace(/\\/g, '/'), pair });
    }
  }
}

// ---- helpers ---------------------------------------------------------------

/** A cache that never hits and never stores - the cold cache as an invariant, not a step. */
const nullCache = { get: () => undefined, set: () => {}, flush: async () => true, size: 0 };

/** Records every teacher call's raw text (success or failure) to the raw sidecar. `generate()` sees exactly the real result. */
function recordingTeacher(sessionId) {
  return {
    name: provider.name,
    model: provider.model,
    complete: async (request) => {
      const startedAt = Date.now();
      const result = await provider.complete(request);
      writeLine(rawPath, {
        sessionId,
        capturedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        model: result.ok ? result.value.model : provider.model,
        request: { system: request.system, user: request.user, schema: request.schema ?? null },
        ok: result.ok,
        rawText: result.ok ? result.value.text : null,
        usage: result.ok ? result.value.usage : null,
        error: result.ok ? null : result.error,
      });
      return result;
    },
  };
}

/**
 * Rebuilds the exact request `generateComponentFile` sends for one component
 * against `finalFiles`, without any real model: the stub records the request
 * and answers with the final file, so the returned GeneratedFile is that same
 * file and the recorded request is byte-for-byte what a real call would send.
 */
async function rebuildRequest(schema, component, domain, priorViolation, finalFiles, finalContents) {
  let recorded = null;
  const stub = {
    name: 'recording-stub',
    model: provider.model,
    complete: async (request) => {
      recorded = { system: request.system, user: request.user, schema: request.schema ?? null };
      return {
        ok: true,
        value: { text: JSON.stringify({ code: finalContents }), model: provider.model, usage: { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 } },
      };
    },
  };
  const generator = createComponentCodeGenerator({ provider: stub, cache: nullCache, skipCache: true });
  const result = await generateComponentFile(generator, schema, component, domain, priorViolation, finalFiles);
  if (!result.ok || recorded === null) throw new Error(`could not rebuild request for ${component.name}: ${JSON.stringify(result)}`);
  return recorded;
}

const summary = {
  projects: { total: 0, skipped: 0, generated: 0, generationFailed: 0, buildOk: 0, runtimeOk: 0 },
  records: {},
  reasons: {},
};
const bump = (table, key) => (table[key] = (table[key] ?? 0) + 1);

// ---- main loop -------------------------------------------------------------

console.log(`capturing code from ${plans.length} plan(s) -> ${outPath}`);
console.log(`teacher: ${provider.name} (${provider.model}); raw text -> ${rawPath}; per-project log -> ${projectsPath}`);
console.log(`work directory: ${workRoot}; already done: ${done.size}`);
console.log();

let processed = 0;
for (const { sourceFile, pair } of plans) {
  if (processed >= limit) break;
  const validated = validateProjectSchema(pair.schema);
  if (!validated.ok) {
    console.log(`!! ${sourceFile}: schema failed validateProjectSchema, skipped (${validated.error.length} rejection(s))`);
    continue;
  }
  const schema = validated.value;
  const sessionId = schema.sessionId;
  summary.projects.total += 1;
  if (done.has(sessionId)) {
    summary.projects.skipped += 1;
    continue;
  }
  processed += 1;
  const startedAt = new Date().toISOString();
  const root = join(workRoot, sessionId);
  const teacher = recordingTeacher(sessionId);
  console.log(`-- ${sessionId} (${schema.title}) [${processed}]`);

  const generated = await generateAndVerifyProject(schema, { provider: teacher, cache: nullCache, skipCache: true, root });
  if (!generated.ok) {
    summary.projects.generationFailed += 1;
    writeLine(projectsPath, { sessionId, sourceFile, startedAt, status: 'generation-failed', error: generated.error, teacher: provider.name });
    console.log(`   generation failed: ${JSON.stringify(generated.error).slice(0, 200)}`);
    continue;
  }
  summary.projects.generated += 1;

  const built = await installBuildAndRepair({ schema, llm: { provider: teacher, cache: nullCache }, root, files: generated.value.files });
  if (!built.ok) {
    summary.projects.generationFailed += 1;
    writeLine(projectsPath, { sessionId, sourceFile, startedAt, status: 'repair-failed', error: built.error, teacher: provider.name });
    console.log(`   build repair failed: ${JSON.stringify(built.error).slice(0, 200)}`);
    continue;
  }
  const finalFiles = built.value.files;
  const buildOk = built.value.build.installOk && built.value.build.buildOk;
  if (buildOk) summary.projects.buildOk += 1;

  // Blueprint and the locator check are re-run on the FINAL files: a build
  // repair rewrites files after generateAndVerifyProject's own check, and a
  // repaired file can violate a rule the original did not.
  let violations = generated.value.unresolvedViolations;
  let locatorFindings = generated.value.unresolvedServiceLocatorFindings;
  if (built.value.regenerationLog.length > 0) {
    const reverified = await verifyGeneratedProject(root, schema);
    violations = reverified.ok ? reverified.value : [...violations, { kind: 'pipeline-error', message: reverified.error.message }];
    locatorFindings = detectServiceLocatorEvasion(finalFiles, schema.constraints);
  }

  const runtime = buildOk
    ? await runRuntimeCheck(root, schema)
    : { started: false, routes: [], ok: false, serverOutput: 'build failed - server not started' };
  if (runtime.ok) summary.projects.runtimeOk += 1;
  const perComponent = new Map(routeResultsFor(schema, runtime).map((entry) => [entry.targetPath, entry]));

  const projectReasons = [];
  if (!buildOk) projectReasons.push(built.value.build.installOk ? 'build-failed' : 'install-failed');
  if (violations.length > 0) projectReasons.push('blueprint-violation');
  if (locatorFindings.length > 0) projectReasons.push('service-locator-finding');
  if (buildOk && !runtime.started) projectReasons.push('runtime-not-started');

  const regenerationLog = [...generated.value.regenerationLog, ...built.value.regenerationLog];
  const teacherLabel = provider.name;

  function reasonsFor(targetPath) {
    const reasons = [...projectReasons];
    const routeCheck = perComponent.get(targetPath);
    if (routeCheck !== undefined && runtime.started && !routeCheck.passed) reasons.push('runtime-route-failed');
    return reasons;
  }

  let written = 0;
  for (const file of finalFiles) {
    const owner = findComponentByTargetPath(schema, file.path);
    if (owner === null) continue;
    if (domainFilter !== null && !domainFilter.has(owner.domain)) continue;
    const reasons = reasonsFor(file.path);
    const request = await rebuildRequest(schema, owner.component, owner.domain, undefined, finalFiles, file.contents);
    const record = {
      recordId: `${sessionId}:first:${owner.component.id}`,
      sourceFile,
      sessionId,
      kind: 'first',
      domain: owner.domain,
      component: { id: owner.component.id, name: owner.component.name, purpose: owner.component.purpose },
      targetPath: file.path,
      request,
      code: file.contents,
      accepted: reasons.length === 0,
      reasons,
      teacher: teacherLabel,
      capturedAt: new Date().toISOString(),
    };
    writeLine(outPath, record);
    written += 1;
    bump(summary.records, `${owner.domain}/${record.accepted ? 'accepted' : 'rejected'}`);
    for (const reason of reasons) bump(summary.reasons, reason);
  }

  // Correction examples: the recorded CORRECTION prompt (the real
  // firstAttemptViolation, re-fed through the same prompt builder) paired
  // with the file as it finally stands.
  const correctionCounts = new Map();
  for (const attempt of regenerationLog) {
    if (domainFilter !== null && !domainFilter.has(attempt.domain)) continue;
    const finalFile = finalFiles.find((f) => f.path === attempt.targetPath);
    if (finalFile === undefined) continue;
    const n = (correctionCounts.get(attempt.targetPath) ?? 0) + 1;
    correctionCounts.set(attempt.targetPath, n);
    const reasons = reasonsFor(attempt.targetPath);
    const request = await rebuildRequest(schema, attempt.component, attempt.domain, attempt.firstAttemptViolation, finalFiles, finalFile.contents);
    const record = {
      recordId: `${sessionId}:correction:${attempt.component.id}:${n}`,
      sourceFile,
      sessionId,
      kind: 'correction',
      domain: attempt.domain,
      component: { id: attempt.component.id, name: attempt.component.name, purpose: attempt.component.purpose },
      targetPath: attempt.targetPath,
      request,
      code: finalFile.contents,
      accepted: reasons.length === 0,
      reasons,
      teacher: teacherLabel,
      capturedAt: new Date().toISOString(),
      // Extra provenance beyond the contract's keys, never used for training: which retry produced this prompt.
      correctionOrigin: attempt.origin,
      correctionOutcome: attempt.outcome,
    };
    writeLine(outPath, record);
    written += 1;
    bump(summary.records, `${attempt.domain}/correction/${record.accepted ? 'accepted' : 'rejected'}`);
  }

  writeLine(projectsPath, {
    sessionId,
    sourceFile,
    startedAt,
    status: 'captured',
    records: written,
    build: built.value.build,
    violations: violations.length,
    locatorFindings: locatorFindings.length,
    // serverOutput kept: without it a 'not started' is undiagnosable from the log alone.
    runtime: { started: runtime.started, ok: runtime.ok, routes: runtime.routes, serverOutput: runtime.serverOutput },
    regenerations: regenerationLog.length,
    teacher: teacherLabel,
  });
  const marker = projectReasons.length === 0 && runtime.ok ? 'ok ' : '!! ';
  console.log(`${marker} build=${buildOk} violations=${violations.length} locator=${locatorFindings.length} runtime=${runtime.ok} records=${written}${projectReasons.length ? ' ' + projectReasons.join(',') : ''}`);
}

console.log();
console.log('--- summary ---');
console.log(`projects: ${JSON.stringify(summary.projects)}`);
console.log('records per domain:');
for (const [key, value] of Object.entries(summary.records).sort()) console.log(`  ${key}: ${value}`);
console.log('rejection reasons:');
for (const [key, value] of Object.entries(summary.reasons).sort()) console.log(`  ${key}: ${value}`);
console.log(`\nrecords written to ${outPath}`);
