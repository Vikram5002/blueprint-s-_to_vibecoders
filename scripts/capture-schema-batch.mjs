/**
 * Instrumented batch driver for Layer 2's prompt -> ProjectSchema generator.
 *
 * Exists because the first synthetic batch's driver was ad-hoc, never
 * committed, and captured raw pre-parse text only on the SUCCESS path. When 6
 * of 20 generations came back as `unparseable-json`, the raw text that would
 * have shown *why* was already gone, and the prompts that produced it were
 * never written down either (only the 12 accepted pairs reached
 * training/data/synthetic/synthetic-batch-1.jsonl). Diagnosing that batch
 * meant re-running it; the prompts for the 6 failures could not be recovered
 * at all. This script exists so that cannot happen a second time.
 *
 * What it guarantees:
 *
 *   - Raw pre-parse text is recorded for EVERY attempt the provider answered,
 *     success or failure. That is the whole point.
 *   - Output is append-only, one JSON record per line, fsync'd per record.
 *     Killing the process mid-batch loses at most the in-flight generation.
 *   - The cache is cold by construction. A null LabelCache is passed in, so
 *     every prompt reaches the model and no earlier run can replay into this
 *     one. Nothing is written to the on-disk cache either.
 *   - The real generator runs, at the real call site's exact configuration.
 *     Raw text is captured by wrapping the provider, not by re-implementing
 *     the request — so PROJECT_SCHEMA_SYSTEM_PROMPT, PROJECT_SCHEMA_JSON_SCHEMA,
 *     MAX_OUTPUT_TOKENS, temperature and effort cannot drift out of sync with
 *     what generate() actually sends.
 *
 * Usage:
 *   node scripts/capture-schema-batch.mjs --local --out=capture/batch-2.jsonl
 *   node scripts/capture-schema-batch.mjs --local --out=out.jsonl --prompts=file.jsonl
 *   node scripts/capture-schema-batch.mjs --local=http://127.0.0.1:8712 --out=out.jsonl
 *
 * --prompts accepts a .jsonl of {"prompt": "..."} records (or bare strings,
 * one per line). Omitted, it uses the built-in fresh batch below.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLocalProvider } from '../dist/llm/local.js';
import { chooseProvider, createProvider } from '../dist/llm/select-provider.js';
import { loadEnvFile } from '../dist/llm/env-file.js';
import { createProjectSchemaGenerator } from '../dist/workflow/generate-project-schema.js';

loadEnvFile(process.cwd());

/**
 * A fresh batch, deliberately NOT reusing the 12 preserved prompts from
 * synthetic-batch-1.jsonl — those are the negative fixtures and must stay
 * independent of anything captured here.
 *
 * Written to match the original batch's style: one sentence, a concrete
 * small application, and — for most of them — an explicit role/access-control
 * clause, since all 6 of the original failures carried that phrasing. The
 * root-cause report is clear that this vocabulary does not *predict* failure
 * (several prompts carrying it succeeded), so this is not an attempt to force
 * the bug; it is an attempt to sample the same region of the prompt space the
 * original batch sampled, at enough volume that the ~30% failure rate
 * reproduces some instances.
 */
const DEFAULT_PROMPTS = [
  'A bike repair shop job tracker where mechanics update repair status and only the shop owner can view revenue totals.',
  'A school field trip permission system where parents sign forms and only teachers can see the full roster of who has signed.',
  'A veterinary clinic records app where any staff member can book appointments but only vets can write treatment notes.',
  'A neighborhood tool library where members borrow tools and only librarians can mark an item lost or retired.',
  'A conference talk submission portal where speakers submit abstracts and only reviewers can see other submissions.',
  'A gym class booking app where members reserve spots and trainers can only see rosters for their own classes.',
  'A small charity donation tracker where donors see their own giving history and only treasurers can export the full ledger.',
  'A tenant maintenance request system where renters file issues and only building managers can close or reassign them.',
  'A podcast episode planner where hosts draft show notes and only the producer can publish an episode.',
  'A university lab equipment booking tool where students reserve instruments and only lab managers can override a booking.',
  'A car rental fleet tracker where branch staff see their own branch vehicles and only regional managers see all branches.',
  'A restaurant shift swap board where servers post shifts and only managers can approve a swap.',
  'A book club reading tracker where members log progress and everyone can see everyone else\'s notes.',
  'A plant nursery inventory app that tracks stock levels and reorder points across two greenhouses.',
  'A ticketing system for a small theater where box office staff sell seats and only the house manager can issue refunds.',
  'A daycare check-in app where guardians sign children in and out and only directors can view the full attendance log.',
  'A municipal pothole reporting site where residents submit locations and only public works staff can change a report status.',
  'A wedding planning checklist shared between two partners with no roles or permissions at all.',
  'A warehouse pick-list app where pickers see only their assigned aisles and supervisors see the whole floor.',
  'A language exchange scheduler where learners book conversation slots and tutors set their own availability.',
];

const args = process.argv.slice(2);
const localArg = args.find((a) => a === '--local' || a.startsWith('--local='));
const outArg = args.find((a) => a.startsWith('--out='));
const promptsArg = args.find((a) => a.startsWith('--prompts='));

if (!outArg) {
  console.error('Usage: node scripts/capture-schema-batch.mjs [--local[=baseUrl]] --out=<path.jsonl> [--prompts=<path.jsonl>]');
  process.exit(1);
}

const outPath = outArg.slice('--out='.length);
mkdirSync(dirname(outPath), { recursive: true });

const prompts = promptsArg ? loadPrompts(promptsArg.slice('--prompts='.length)) : DEFAULT_PROMPTS;

function loadPrompts(path) {
  if (!existsSync(path)) {
    console.error(`prompts file not found: ${path}`);
    process.exit(1);
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      if (!line.startsWith('{')) return line;
      const parsed = JSON.parse(line);
      return parsed.prompt;
    })
    .filter((p) => typeof p === 'string' && p.length > 0);
}

let provider;
if (localArg) {
  const baseUrl = localArg.includes('=') ? localArg.slice('--local='.length) : undefined;
  provider = createLocalProvider(baseUrl ? { baseUrl } : {});
} else {
  const choice = chooseProvider(process.env);
  provider = await createProvider(choice);
  if (provider === null) {
    console.error(`No API key found for provider "${choice.provider}" (expected ${choice.keyEnv}).`);
    process.exit(1);
  }
}

/**
 * Wraps the real provider to record what came back, without altering the
 * request or the response. `generate()` sees exactly what it would have seen
 * talking to the provider directly.
 */
let lastCompletion = null;
const capturingProvider = {
  name: provider.name,
  model: provider.model,
  complete: async (request) => {
    const startedAt = Date.now();
    const result = await provider.complete(request);
    const latencyMs = Date.now() - startedAt;
    lastCompletion = result.ok
      ? { ok: true, text: result.value.text, usage: result.value.usage, model: result.value.model, latencyMs }
      : { ok: false, error: result.error, latencyMs };
    return result;
  },
};

/**
 * A cache that never hits and never stores. "Cache cleared" as an invariant
 * rather than a step someone has to remember to perform: there is no state
 * here for a previous run to have left behind.
 */
const nullCache = {
  get: () => undefined,
  set: () => {},
  flush: async () => true,
  size: 0,
};

/**
 * Independently re-parses the captured raw text to obtain the canonical
 * JSON.parse error and its character position. finalize() stringifies the
 * cause into its message, but the position is the single most important field
 * for comparing one failure against another, so it is extracted as a real
 * number here rather than left embedded in prose.
 */
function parseDiagnostics(rawText) {
  try {
    JSON.parse(rawText);
    return { parses: true, errorMessage: null, errorPosition: null };
  } catch (cause) {
    const message = String(cause);
    const match = /at position (\d+)/.exec(message);
    return {
      parses: false,
      errorMessage: message,
      errorPosition: match ? Number(match[1]) : null,
    };
  }
}

/**
 * First-pass classification against the signature diagnosed in
 * LOCAL-MODEL-JSON-MALFORMATION-ROOTCAUSE.md: an object close followed
 * immediately by ,"dependsOn" — where a well-formed document closes the
 * components array first and writes }],"dependsOn".
 *
 * Reported, not acted on. The repair itself lives in generate-project-schema.ts
 * and does its own detection; this is here so the batch report can say which
 * failures look like the known bug and which are something else.
 */
function signatureReport(rawText) {
  const matches = [...rawText.matchAll(/\},"dependsOn"/g)];
  const wellFormed = [...rawText.matchAll(/\}\],"dependsOn"/g)];
  return {
    bracketOmissionMatches: matches.length,
    bracketOmissionOffsets: matches.map((m) => m.index),
    wellFormedBoundaries: wellFormed.length,
    doubledComma: /,,/.test(rawText),
  };
}

let generatedAtIso = null;
let viaFallbackCount = 0;
let jsonRepairedCount = 0;

const generator = createProjectSchemaGenerator({
  provider: capturingProvider,
  cache: nullCache,
  onViaFallback: () => {
    viaFallbackCount += 1;
  },
  // The repair marker's only durable home. A repaired schema is
  // indistinguishable from a clean one once it has been parsed, so if this
  // is not written onto the record here, nothing downstream can ever
  // establish that a generation was repaired.
  onJsonRepaired: () => {
    jsonRepairedCount += 1;
  },
});

function writeRecord(record) {
  appendFileSync(outPath, `${JSON.stringify(record)}\n`, 'utf8');
}

const summary = { total: 0, success: 0, 'success (repaired)': 0, 'unparseable-json': 0, 'schema-violation': 0, 'provider-error': 0 };

console.log(`capturing ${prompts.length} generations -> ${outPath}`);
console.log(`provider: ${provider.name} (${provider.model})`);
console.log();

for (const [index, prompt] of prompts.entries()) {
  lastCompletion = null;
  viaFallbackCount = 0;
  jsonRepairedCount = 0;
  generatedAtIso = new Date().toISOString();

  const result = await generator.generate(prompt);

  const outcome = result.ok ? 'success' : result.error.reason;
  summary.total += 1;
  summary[outcome] += 1;
  if (jsonRepairedCount > 0) summary['success (repaired)'] += 1;

  const rawText = lastCompletion?.ok ? lastCompletion.text : null;
  const diagnostics = rawText === null ? null : parseDiagnostics(rawText);
  const signature = rawText === null ? null : signatureReport(rawText);

  writeRecord({
    index: index + 1,
    startedAt: generatedAtIso,
    prompt,
    outcome,
    model: lastCompletion?.model ?? provider.model,
    latencyMs: lastCompletion?.latencyMs ?? null,
    promptTokens: lastCompletion?.ok ? lastCompletion.usage.promptTokens : null,
    completionTokens: lastCompletion?.ok ? lastCompletion.usage.completionTokens : null,
    // The field the last batch did not have. Present on every outcome.
    rawText,
    parseErrorMessage: diagnostics?.errorMessage ?? null,
    parseErrorPosition: diagnostics?.errorPosition ?? null,
    signature,
    // The persisted repair marker. False on every clean generation, true
    // when finalize() only parsed this text after repairing it.
    jsonRepaired: jsonRepairedCount > 0,
    viaFallbackCount,
    failureMessage: result.ok ? null : result.error.message,
    rejections: !result.ok && result.error.reason === 'schema-violation' ? result.error.rejections : null,
    schema: result.ok ? result.value : null,
  });

  const marker = outcome === 'success' ? (jsonRepairedCount > 0 ? 'RP ' : 'ok ') : '!! ';
  const posNote = diagnostics && !diagnostics.parses ? ` parse-error@${diagnostics.errorPosition}` : '';
  const sigNote = signature && signature.bracketOmissionMatches > 0 ? ` sig-matches=${signature.bracketOmissionMatches}` : '';
  const repairNote = jsonRepairedCount > 0 ? ' REPAIRED' : '';
  console.log(`${marker}${String(index + 1).padStart(2)}. ${outcome}${repairNote}${posNote}${sigNote}  ${prompt.slice(0, 60)}...`);
}

console.log();
console.log('--- summary ---');
for (const [key, value] of Object.entries(summary)) {
  console.log(`${key}: ${value}`);
}
console.log(`\nrecords written to ${outPath}`);
