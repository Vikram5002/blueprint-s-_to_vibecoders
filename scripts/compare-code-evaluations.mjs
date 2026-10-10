#!/usr/bin/env node
/** Compare two completed eval-code-model JSON reports on their shared component set. */
import { readFileSync } from 'node:fs';
import { compareEvaluationReports } from './code-evaluation-statistics.mjs';

function option(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
  return value === undefined ? fallback : value.slice(prefix.length);
}

const paths = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
if (paths.length !== 2) {
  console.error('Usage: node scripts/compare-code-evaluations.mjs <baseline.json> <candidate.json> [--metric=A|B|D_A|D_B]');
  process.exitCode = 2;
} else {
  try {
    const baseline = JSON.parse(readFileSync(paths[0], 'utf8'));
    const candidate = JSON.parse(readFileSync(paths[1], 'utf8'));
    const result = compareEvaluationReports(baseline, candidate, option('metric', 'A'));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
