#!/usr/bin/env node
/**
 * Training data for the repair coder: real form fixes by the teacher.
 *
 * Accepted teacher pages were accepted before the form check existed, and
 * many do not match their own project's API (in rich-w1/w2 and rich2-w1, 97
 * calls named a route that does not exist and 60 sent the wrong fields). For
 * every such page this asks the teacher for the corrected page with the exact
 * CORRECTION prompt the pipeline sends (form-repair.ts formContext, rendered as
 * component-codegen.ts renders it), and keeps the answer only when the form
 * check's own static reading finds nothing wrong with it. Each kept fix is a
 * capture-format correction record (teacher "teacher-form-fix").
 *
 * Usage (after npm run build:server; a teacher served on the local protocol):
 *   node scripts/capture-form-fixes.mjs capture/code/rich-w*.jsonl --local=http://127.0.0.1:8712 --model=teacher \
 *     --out=capture/code/teacher-form-fixes.jsonl [--concurrency=6]
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { apiRoutes, pageCalls, staticProblems } from '../dist/generate/form-check.js';
import { formContext } from '../dist/generate/form-repair.js';
import { COMPONENT_CODE_JSON_SCHEMA, COMPONENT_CODE_SYSTEM_PROMPT, MAX_OUTPUT_TOKENS, extractCode } from '../dist/generate/component-codegen.js';
import { createLocalProvider } from '../dist/llm/local.js';

const args = process.argv.slice(2);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = value('out') ?? 'capture/code/teacher-form-fixes.jsonl';
const provider = createLocalProvider({ baseUrl: value('local') ?? 'http://127.0.0.1:8712', model: value('model') ?? 'teacher' });
const concurrency = Number(value('concurrency') ?? 6);
const inputs = args.filter((a) => !a.startsWith('--'));

function correctionUser(firstUser, context) {
  return [
    firstUser,
    '',
    "CORRECTION REQUIRED - your previous attempt at this exact file was already written to disk and checked against the project's real architecture. It violated a stated rule:",
    `  Rule violated: ${context.ruleText}`,
    `  What happened: ${context.explanation}`,
    'The exact offending line(s) from your previous attempt:',
    ...context.evidence.map((e) => `  ${e.file}:${e.line}: ${e.snippet}`),
    context.fixInstruction,
  ].join('\n');
}

const records = inputs.flatMap((file) => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)));
const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).fixOf) : []);
const routesBySession = new Map();
for (const r of records) {
  if (!r.accepted || r.domain !== 'backend' || !r.targetPath.startsWith('backend/src/routes/')) continue;
  const list = routesBySession.get(r.sessionId) ?? [];
  // The last accepted version of each route file wins (a correction replaces its first attempt).
  routesBySession.set(r.sessionId, [...list.filter((x) => x.file !== r.targetPath), ...apiRoutes(r.targetPath, r.targetPath.split('/').at(-1).replace(/\.ts$/, ''), r.code)]);
}

const jobs = [];
for (const page of records) {
  if (!page.accepted || page.domain !== 'frontend' || page.kind === 'correction' || done.has(page.recordId)) continue;
  const routes = routesBySession.get(page.sessionId) ?? [];
  if (routes.length === 0) continue;
  const problems = staticProblems(pageCalls(page.targetPath, page.code), routes);
  if (problems.length > 0) jobs.push({ page, routes, problems });
}
console.log(`${records.length} records; ${jobs.length} pages that do not match their API`);

let kept = 0, rejected = 0, failed = 0, next = 0;
async function worker() {
  while (next < jobs.length) {
    const { page, routes, problems } = jobs[next++];
    const user = correctionUser(page.request.user, formContext(page.targetPath, problems));
    const result = await provider.complete({ system: COMPONENT_CODE_SYSTEM_PROMPT, user, maxOutputTokens: MAX_OUTPUT_TOKENS, schema: COMPONENT_CODE_JSON_SCHEMA, temperature: 0 });
    const code = result.ok ? extractCode(result.value.text) : null;
    if (code === null || !code.ok) { failed++; continue; }
    const after = staticProblems(pageCalls(page.targetPath, code.value), routes);
    const calls = pageCalls(page.targetPath, code.value).filter((c) => c.fields !== null);
    if (after.length > 0 || calls.length === 0) { rejected++; continue; }
    kept++;
    const digest = createHash('sha256').update(`${page.recordId}:form-fix`).digest('hex').slice(0, 16);
    appendFileSync(out, JSON.stringify({
      ...page,
      recordId: `${page.sessionId}:teacher-form-fix:${digest}`,
      fixOf: page.recordId,
      kind: 'correction',
      request: { ...page.request, user },
      code: code.value,
      accepted: true,
      reasons: [`teacher fix of ${problems.length} form problem(s); the fixed page matches its API (form check, static)`],
      teacher: 'teacher-form-fix',
    }) + '\n');
    if ((kept + rejected + failed) % 10 === 0) console.log(`progress: kept ${kept}, rejected ${rejected}, failed ${failed} of ${jobs.length}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
console.log(`done: kept ${kept}, rejected ${rejected}, failed ${failed} of ${jobs.length} -> ${out}`);
