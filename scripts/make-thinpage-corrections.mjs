#!/usr/bin/env node
/**
 * Training data for the repair coder: a placeholder page rewritten into a real one.
 *
 * Found live (2026-10-23, finance app): the round-1 coder wrote five 10-line
 * pages with a title and a sentence; the form check now flags such a page
 * (form-check.ts unusedPages). This builds the correction record for it,
 * with no teacher: for every WORKING page - one that calls the API and whose
 * every call matches its project's routes, from the training captures or the
 * teacher's verified form fixes - the prompt is the page's own request plus
 * the CORRECTION the pipeline sends for an unused page (the checker's exact
 * words via unusedPageMessage, rendered as component-codegen.ts renders it),
 * and the answer is the working page.
 *
 * Usage (after npm run build:server):
 *   node scripts/make-thinpage-corrections.mjs capture/code/rich-w*.jsonl capture/code/teacher-form-fixes.jsonl \
 *     --out=capture/code/synthetic-thinpage-corrections.jsonl
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { apiRoutes, pageCalls, staticProblems, unusedPageMessage } from '../dist/generate/form-check.js';
import { formContext } from '../dist/generate/form-repair.js';

const args = process.argv.slice(2);
const out = args.find((a) => a.startsWith('--out='))?.slice(6) ?? 'capture/code/synthetic-thinpage-corrections.jsonl';
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

/** A request without any earlier CORRECTION block - the first-attempt prompt the page was written for. */
const firstRequest = (user) => user.split('\n\nCORRECTION REQUIRED')[0];

const records = inputs.flatMap((file) => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)));
const routesBySession = new Map();
for (const r of records) {
  if (!r.accepted || r.domain !== 'backend' || !r.targetPath.startsWith('backend/src/routes/')) continue;
  const list = routesBySession.get(r.sessionId) ?? [];
  routesBySession.set(r.sessionId, [...list.filter((x) => x.file !== r.targetPath), ...apiRoutes(r.targetPath, r.targetPath.split('/').at(-1).replace(/\.ts$/, ''), r.code)]);
}

const rows = [];
const seen = new Set();
for (const page of records) {
  if (!page.accepted || page.domain !== 'frontend') continue;
  const routes = routesBySession.get(page.sessionId) ?? [];
  const calls = pageCalls(page.targetPath, page.code);
  if (routes.length === 0 || !/\bfetch\s*\(/.test(page.code) || staticProblems(calls, routes).length > 0) continue;
  const key = `${page.sessionId}:${page.targetPath}`;
  if (seen.has(key)) continue; // one example per page
  seen.add(key);
  const context = formContext(page.targetPath, [{ page: page.targetPath, call: 'none', message: unusedPageMessage(routes) }]);
  const digest = createHash('sha256').update(`${page.recordId}:thin-page`).digest('hex').slice(0, 16);
  rows.push({
    ...page,
    recordId: `${page.sessionId}:synthetic-thinpage:${digest}`,
    kind: 'correction',
    request: { ...page.request, user: correctionUser(firstRequest(page.request.user), context) },
    code: page.code,
    accepted: true,
    reasons: ['synthetic: a placeholder page that called no API; answer is the working page (form check, static)'],
    teacher: 'synthetic-thinpage',
  });
}
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`${records.length} records -> ${rows.length} placeholder-page corrections in ${out}`);
