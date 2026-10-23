#!/usr/bin/env node
/**
 * Training data for the repair coder: synthetic form corrections.
 *
 * The form check (src/generate/form-check.ts) found 13 page calls in 27 apps
 * that did not work against their own API; round 4 fixed 8. This builds
 * correction records for exactly that failure, deterministically and with no
 * teacher - the method round 2 used for invented imports
 * (training/code/make-import-corrections.py):
 *
 *   take an ACCEPTED teacher page whose every data-sending call matches its
 *   project's API (form-check's own readers and staticProblems), break one
 *   call - rename a field the route reads, or point it at a nearby route that
 *   does not exist - run staticProblems on the broken page to get the checker's
 *   real message, and pair the CORRECTION prompt the pipeline would send
 *   (form-repair.ts formContext, rendered as component-codegen.ts renders it)
 *   with the ORIGINAL page as the answer.
 *
 * Output is capture-format JSONL (kind "correction", teacher
 * "synthetic-form-mutation"), so format-code-dataset.py formats it like any
 * other capture. Inputs are training captures only; no evaluation plan or
 * reference project is read.
 *
 * Usage (after npm run build:server):
 *   node scripts/make-form-corrections.mjs capture/code/rich-w*.jsonl --out=capture/code/synthetic-form-corrections.jsonl
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { apiRoutes, pageCalls, staticProblems } from '../dist/generate/form-check.js';
import { formContext } from '../dist/generate/form-repair.js';

const args = process.argv.slice(2);
const out = args.find((a) => a.startsWith('--out='))?.slice(6) ?? 'capture/code/synthetic-form-corrections.jsonl';
const inputs = args.filter((a) => !a.startsWith('--'));

/** The CORRECTION block exactly as component-codegen.ts renders a priorViolation. */
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

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
/** A plausible wrong name for a field: the other naming style, or a near synonym. */
function wrongField(field) {
  if (field.includes('_')) return camel(field);
  if (/[A-Z]/.test(field)) return snake(field);
  const swaps = { name: 'title', title: 'name', email: 'mail', phone: 'mobile', date: 'day', quantity: 'qty', description: 'details', notes: 'note' };
  return swaps[field] ?? `${field}Value`;
}
/** A plausible wrong last segment for a route: singular/plural, or an action word. */
function wrongPath(path) {
  const parts = path.split('/');
  const last = parts.at(-1) ?? '';
  parts[parts.length - 1] = last.endsWith('s') ? last.slice(0, -1) : last.length > 0 ? `${last}s` : 'create';
  return parts.join('/');
}

const records = inputs.flatMap((file) => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)));
const bySession = new Map();
for (const r of records) {
  if (!r.accepted) continue;
  if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
  bySession.get(r.sessionId).push(r);
}

const rows = [];
let pages = 0;
for (const [, session] of bySession) {
  const routes = session
    .filter((r) => r.domain === 'backend' && r.targetPath.startsWith('backend/src/routes/'))
    .flatMap((r) => apiRoutes(r.targetPath, r.targetPath.split('/').at(-1).replace(/\.ts$/, ''), r.code));
  for (const page of session.filter((r) => r.domain === 'frontend' && r.kind !== 'correction')) {
    const calls = pageCalls(page.targetPath, page.code).filter((c) => c.fields !== null && c.fields.length > 0);
    if (calls.length === 0 || staticProblems(calls, routes).length > 0) continue; // only pages that already work
    pages += 1;
    const call = calls[0];
    const field = call.fields[0];
    const mutants = [];
    // 1. A renamed field: every `field` key in the page becomes the wrong name.
    const renamed = wrongField(field);
    const keyPattern = new RegExp(`\\b${field}\\b(?=\\s*[:,}])|(?<=\\.)${field}\\b`, 'g');
    mutants.push({ kind: 'field', code: page.code.replace(keyPattern, renamed), detail: `${field} -> ${renamed}` });
    // 2. A wrong route: the call's last path segment changed.
    const literal = call.path.replace(/\/1(?=\/|$)/g, '');
    if (page.code.includes(literal)) mutants.push({ kind: 'route', code: page.code.split(literal).join(wrongPath(literal)), detail: `${literal} -> ${wrongPath(literal)}` });
    for (const mutant of mutants) {
      if (mutant.code === page.code) continue;
      const problems = staticProblems(pageCalls(page.targetPath, mutant.code), routes);
      if (problems.length === 0) continue; // the checker must see the break, or the example teaches nothing
      const context = formContext(page.targetPath, problems);
      const digest = createHash('sha256').update(`${page.recordId}:${mutant.kind}:${mutant.detail}`).digest('hex').slice(0, 16);
      rows.push({
        ...page,
        recordId: `${page.sessionId}:synthetic-form:${digest}`,
        kind: 'correction',
        request: { ...page.request, user: correctionUser(page.request.user, context) },
        code: page.code, // the answer is the original, working page
        accepted: true,
        reasons: [`synthetic: ${mutant.detail} (form check); answer is the accepted original`],
        teacher: 'synthetic-form-mutation',
      });
    }
  }
}
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`${records.length} records, ${pages} working pages with data calls -> ${rows.length} form corrections in ${out}`);
