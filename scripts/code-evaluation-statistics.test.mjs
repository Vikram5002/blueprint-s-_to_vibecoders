import assert from 'node:assert/strict';
import { compareEvaluationReports, exactMcNemar, wilsonInterval } from './code-evaluation-statistics.mjs';

function check(name, run) {
  run();
  console.log(`ok - ${name}`);
}

check('Wilson interval reports a bounded 95% score interval', () => {
  const interval = wilsonInterval(8, 10);
  assert.equal(interval.proportion, 0.8);
  assert.ok(interval.lower > 0.4 && interval.lower < 0.6);
  assert.ok(interval.upper > 0.9 && interval.upper < 1);
});

check('Wilson interval handles all failures and rejects invalid inputs', () => {
  const interval = wilsonInterval(0, 10);
  assert.equal(interval.lower, 0);
  assert.ok(interval.upper > 0);
  assert.throws(() => wilsonInterval(0, 0), /greater than zero/);
  assert.throws(() => wilsonInterval(11, 10), /between zero and observations/);
});

check('exact McNemar test counts only discordant paired outcomes', () => {
  // Synthetic fixture: six candidate-only wins and no baseline-only wins.
  const result = exactMcNemar([
    ...Array.from({ length: 6 }, (_, i) => ({ id: `synthetic-win-${i}`, baseline: false, candidate: true })),
    { id: 'synthetic-tie-pass', baseline: true, candidate: true },
    { id: 'synthetic-tie-fail', baseline: false, candidate: false },
  ]);
  assert.equal(result.pairs, 8);
  assert.equal(result.ties, 2);
  assert.equal(result.discordant, 6);
  assert.ok(Math.abs(result.pValue - 0.03125) < 1e-12);
});

check('exact McNemar test rejects unpaired, duplicate, or missing outcomes', () => {
  assert.throws(() => exactMcNemar([]), /non-empty array/);
  assert.throws(
    () => exactMcNemar([{ id: 'x', baseline: true, candidate: true }, { id: 'x', baseline: false, candidate: true }]),
    /duplicate pair id/,
  );
  assert.throws(() => exactMcNemar([{ id: 'x', baseline: true, candidate: null }]), /boolean/);
  assert.throws(() => exactMcNemar([{ id: '', baseline: true, candidate: false }]), /non-empty id/);
});

check('report comparison requires exact component pairing and produces real-statistic fields', () => {
  const report = (candidate, outcomes) => ({
    candidateModel: candidate,
    reference: 'synthetic-fixture-only',
    rates: { n: outcomes.length },
    rows: outcomes.map((result, index) => ({
      sessionId: `synthetic-session-${index}`,
      targetPath: `synthetic/component-${index}.ts`,
      A: result,
    })),
  });
  const baseline = report('synthetic-baseline', [false, true, true, true]);
  const candidate = report('synthetic-candidate', [true, true, false, false]);
  const result = compareEvaluationReports(baseline, candidate, 'A');
  assert.equal(result.observations, 4);
  assert.equal(result.baseline.successes, 3);
  assert.equal(result.candidate.successes, 2);
  assert.equal(result.pairedTest.candidateOnly, 1);
  assert.equal(result.pairedTest.baselineOnly, 2);
  assert.throws(
    () => compareEvaluationReports(
      baseline,
      { ...candidate, rates: { n: candidate.rows.length - 1 }, rows: candidate.rows.slice(1) },
      'A',
    ),
    /not fully paired/,
  );
  assert.throws(() => compareEvaluationReports(baseline, { ...candidate, reference: 'other' }, 'A'), /different reference sets/);
});

console.log('All code-evaluation statistics checks passed.');
