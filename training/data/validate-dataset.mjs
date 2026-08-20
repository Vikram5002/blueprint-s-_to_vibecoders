/**
 * Validates every pair in one or more dataset JSONL files against the real
 * ProjectSchema validator, and flags near-duplicate prompts.
 *
 * Thin wrapper over the compiled src/workflow/dataset.js — see
 * training/data/METHODOLOGY.md for what this dataset is and the three-source
 * plan (hand-written / real-project / synthetic). Requires `npm run build`
 * (or `npx tsc`) first, same as every other script in scripts/.
 *
 * A pair that fails schema validation is reported with its specific
 * reason(s) and the run exits non-zero. Nothing is ever silently dropped or
 * silently kept — see dataset.ts's module doc for why.
 *
 * Usage:
 *   node training/data/validate-dataset.mjs
 *   node training/data/validate-dataset.mjs training/data/gold/gold.jsonl
 *   node training/data/validate-dataset.mjs --dup-threshold=0.9
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const dist = new URL('../../dist/', import.meta.url);

const { validateDatasetPair, findNearDuplicatePrompts } = await import(new URL('workflow/dataset.js', dist).href);

const args = process.argv.slice(2);
const thresholdArg = args.find((a) => a.startsWith('--dup-threshold='));
const DUP_THRESHOLD = thresholdArg ? Number(thresholdArg.slice('--dup-threshold='.length)) : 0.8;
const explicitFiles = args.filter((a) => !a.startsWith('--'));

const DEFAULT_FILES = [join(repoRoot, 'training', 'data', 'gold', 'gold.jsonl')];

const files = (explicitFiles.length > 0 ? explicitFiles : DEFAULT_FILES).filter((path) => {
  if (!existsSync(path)) {
    console.warn(`skip (not found): ${path}`);
    return false;
  }
  return true;
});

if (files.length === 0) {
  console.error('No dataset files found to validate.');
  process.exit(1);
}

let totalPairs = 0;
let totalFailures = 0;
/** @type {{file: string, index: number, prompt: string}[]} */
const allPrompts = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf-8').split('\n').filter((line) => line.trim().length > 0);
  console.log(`\n${file}: ${lines.length} pair(s)`);

  lines.forEach((line, index) => {
    totalPairs += 1;
    const lineNumber = index + 1;

    let candidate;
    try {
      candidate = JSON.parse(line);
    } catch (error) {
      totalFailures += 1;
      console.error(`  FAIL line ${lineNumber}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
      return;
    }

    const result = validateDatasetPair(candidate);
    if (!result.ok) {
      totalFailures += 1;
      console.error(`  FAIL line ${lineNumber} (${candidate?.schema?.sessionId ?? 'unknown session'}):`);
      for (const rejection of result.error) {
        const detail = 'errors' in rejection ? ` [${rejection.errors.length} schema violation(s)]` : '';
        console.error(`    - ${rejection.path}: ${rejection.reason}${detail}`);
      }
      return;
    }

    allPrompts.push({ file, index: lineNumber, prompt: result.value.prompt });
  });
}

console.log(`\nValidated ${totalPairs} pair(s) across ${files.length} file(s): ${totalPairs - totalFailures} passed, ${totalFailures} failed.`);

const duplicates = findNearDuplicatePrompts(
  allPrompts.map((p) => p.prompt),
  DUP_THRESHOLD,
);

if (duplicates.length > 0) {
  console.warn(`\n${duplicates.length} near-duplicate prompt pair(s) at threshold ${DUP_THRESHOLD}:`);
  for (const dup of duplicates) {
    const a = allPrompts[dup.indexA];
    const b = allPrompts[dup.indexB];
    console.warn(`  ${(dup.similarity * 100).toFixed(0)}% similar:`);
    console.warn(`    ${a.file}:${a.index} "${a.prompt}"`);
    console.warn(`    ${b.file}:${b.index} "${b.prompt}"`);
  }
} else {
  console.log('No near-duplicate prompts found.');
}

if (totalFailures > 0) {
  process.exit(1);
}
