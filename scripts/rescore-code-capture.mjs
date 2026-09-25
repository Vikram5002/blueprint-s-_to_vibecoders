/**
 * Re-scores an existing code capture with per-file acceptance
 * (docs/GPU-COMPUTE-PROPOSAL.md A1), without calling any model or rebuilding.
 *
 * Reads <capture>.jsonl and <capture>.projects.jsonl, re-judges every record
 * from the stored build output and runtime routes, and writes
 * <capture>.rescored.jsonl. The original capture is never modified.
 *
 * The per-project log stores only violation and locator-finding COUNTS, not
 * which file they sit in, so a project with either one rejects every file
 * here - never guessed.
 *
 * Usage: node scripts/rescore-code-capture.mjs capture/code/teacher-batch-1.jsonl
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { MAX_FAILURE_OUTPUT_CHARS } from '../dist/generate/build-and-repair.js';
import { createFileJudge } from '../dist/generate/file-acceptance.js';
import { routeResultsFor } from '../dist/generate/runtime-check.js';
import { validateProjectSchema } from '../dist/workflow/validate-project-schema.js';

const capturePath = process.argv[2];
if (!capturePath || !existsSync(capturePath)) {
  console.error('Usage: node scripts/rescore-code-capture.mjs <capture.jsonl>');
  process.exit(1);
}
const stem = join(dirname(capturePath), basename(capturePath, '.jsonl'));
const readJsonl = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));

const records = readJsonl(capturePath);
const projects = new Map(readJsonl(`${stem}.projects.jsonl`).filter((p) => p.status === 'captured').map((p) => [p.sessionId, p]));

const schemas = new Map();
function schemaFor(sourceFile, sessionId) {
  if (!schemas.has(sourceFile)) {
    for (const pair of readJsonl(sourceFile)) {
      const validated = validateProjectSchema(pair.schema);
      if (validated.ok) schemas.set(`${sourceFile}#${validated.value.sessionId}`, validated.value);
    }
    schemas.set(sourceFile, true);
  }
  return schemas.get(`${sourceFile}#${sessionId}`);
}

const judges = new Map();
function judgeFor(record) {
  if (judges.has(record.sessionId)) return judges.get(record.sessionId);
  const project = projects.get(record.sessionId);
  const schema = schemaFor(record.sourceFile, record.sessionId);
  if (project === undefined || schema === undefined) throw new Error(`no project log or schema for ${record.sessionId}`);
  const buildOutput = project.build.failureOutput ?? '';
  const buildOk = project.build.installOk && project.build.buildOk;
  const runtime = { started: project.runtime.started, ok: project.runtime.ok, routes: project.runtime.routes, serverOutput: '' };
  const unattributed = project.violations > 0 || project.locatorFindings > 0;
  const judge = createFileJudge({
    installOk: project.build.installOk,
    buildOk,
    buildOutput,
    buildOutputTruncated: buildOutput.length >= MAX_FAILURE_OUTPUT_CHARS,
    violations: unattributed ? [{}] : [],
    locatorFindings: [],
    runtimeStarted: project.runtime.started,
    routeResults: buildOk ? routeResultsFor(schema, runtime) : routeResultsFor(schema, { ...runtime, started: false }),
  });
  judges.set(record.sessionId, judge);
  return judge;
}

const counts = { before: 0, after: 0, total: records.length };
const byDomain = {};
const rescored = records.map((record) => {
  const reasons = [...judgeFor(record)(record.targetPath)];
  const accepted = reasons.length === 0;
  if (record.accepted) counts.before += 1;
  if (accepted) counts.after += 1;
  const key = `${record.domain}/${record.kind}`;
  byDomain[key] ??= { before: 0, after: 0, total: 0 };
  byDomain[key].total += 1;
  if (record.accepted) byDomain[key].before += 1;
  if (accepted) byDomain[key].after += 1;
  return { ...record, accepted, reasons, acceptance: 'per-file', projectLevelAccepted: record.accepted, projectLevelReasons: record.reasons };
});

writeFileSync(`${stem}.rescored.jsonl`, rescored.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
console.log(`accepted: ${counts.before} -> ${counts.after} of ${counts.total} records`);
for (const [key, value] of Object.entries(byDomain).sort()) console.log(`  ${key}: ${value.before} -> ${value.after} of ${value.total}`);
console.log(`written to ${stem}.rescored.jsonl`);
