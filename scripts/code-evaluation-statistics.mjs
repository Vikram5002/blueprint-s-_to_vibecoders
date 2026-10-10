/** Statistical summaries for paired code-generation evaluation results. */

const DEFAULT_Z_95 = 1.959963984540054;

/** Wilson score interval for a binomial proportion. */
export function wilsonInterval(successes, observations, confidenceZ = DEFAULT_Z_95) {
  assertCount(successes, observations);
  assertPositiveFinite(confidenceZ, 'confidenceZ');
  if (observations === 0) {
    throw new RangeError('observations must be greater than zero');
  }

  const proportion = successes / observations;
  const zSquared = confidenceZ ** 2;
  const denominator = 1 + zSquared / observations;
  const center = (proportion + zSquared / (2 * observations)) / denominator;
  const margin =
    (confidenceZ * Math.sqrt((proportion * (1 - proportion)) / observations + zSquared / (4 * observations ** 2))) /
    denominator;
  return {
    successes,
    observations,
    proportion,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

/**
 * Exact two-sided McNemar test on explicitly paired binary observations.
 * A true value means the component passed. Ties do not contribute to the test.
 */
export function exactMcNemar(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new TypeError('pairs must be a non-empty array');
  }

  const ids = new Set();
  let candidateOnly = 0;
  let baselineOnly = 0;
  let ties = 0;
  for (const [index, pair] of pairs.entries()) {
    if (pair === null || typeof pair !== 'object') {
      throw new TypeError(`pair ${index} must be an object`);
    }
    if (typeof pair.id !== 'string' || pair.id.trim() === '') {
      throw new TypeError(`pair ${index} must have a non-empty id`);
    }
    if (ids.has(pair.id)) throw new RangeError(`duplicate pair id: ${pair.id}`);
    ids.add(pair.id);
    if (typeof pair.baseline !== 'boolean' || typeof pair.candidate !== 'boolean') {
      throw new TypeError(`pair ${pair.id} must contain boolean baseline and candidate results`);
    }
    if (pair.baseline === pair.candidate) ties += 1;
    else if (pair.candidate) candidateOnly += 1;
    else baselineOnly += 1;
  }

  const discordant = candidateOnly + baselineOnly;
  return {
    pairs: pairs.length,
    ties,
    candidateOnly,
    baselineOnly,
    discordant,
    pValue: discordant === 0 ? 1 : exactBinomialTwoSided(Math.min(candidateOnly, baselineOnly), discordant),
  };
}

/** Compare two completed eval-code-model report objects on identical components. */
export function compareEvaluationReports(baseline, candidate, metric = 'A') {
  const allowedMetrics = new Set(['A', 'B', 'D_A', 'D_B']);
  if (!allowedMetrics.has(metric)) {
    throw new RangeError(`metric must be one of ${[...allowedMetrics].join(', ')}`);
  }
  validateReport(baseline, 'baseline', metric);
  validateReport(candidate, 'candidate', metric);
  if (baseline.reference !== candidate.reference) {
    throw new RangeError('reports use different reference sets');
  }

  const baselineRows = indexRows(baseline.rows, 'baseline');
  const candidateRows = indexRows(candidate.rows, 'candidate');
  const baselineIds = [...baselineRows.keys()].sort();
  const candidateIds = [...candidateRows.keys()].sort();
  if (baselineIds.length !== candidateIds.length || baselineIds.some((id, index) => id !== candidateIds[index])) {
    const missing = baselineIds.filter((id) => !candidateRows.has(id));
    const extra = candidateIds.filter((id) => !baselineRows.has(id));
    throw new RangeError(`reports are not fully paired (missing=${missing.length}, extra=${extra.length})`);
  }

  const pairs = baselineIds.map((id) => ({
    id,
    baseline: baselineRows.get(id)[metric],
    candidate: candidateRows.get(id)[metric],
  }));
  const baselineSuccesses = pairs.filter((pair) => pair.baseline).length;
  const candidateSuccesses = pairs.filter((pair) => pair.candidate).length;
  return {
    metric,
    reference: baseline.reference,
    observations: pairs.length,
    baseline: {
      name: baseline.candidateModel ?? baseline.candidate ?? 'baseline',
      successes: baselineSuccesses,
      rate: baselineSuccesses / pairs.length,
      interval95: wilsonInterval(baselineSuccesses, pairs.length),
    },
    candidate: {
      name: candidate.candidateModel ?? candidate.candidate ?? 'candidate',
      successes: candidateSuccesses,
      rate: candidateSuccesses / pairs.length,
      interval95: wilsonInterval(candidateSuccesses, pairs.length),
    },
    pairedTest: exactMcNemar(pairs),
  };
}

function validateReport(report, label, metric) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new TypeError(`${label} report must be an object`);
  }
  if (typeof report.reference !== 'string' || report.reference.trim() === '') {
    throw new TypeError(`${label} report must identify its reference set`);
  }
  if (!Array.isArray(report.rows) || report.rows.length === 0) {
    throw new TypeError(`${label} report must contain completed component rows`);
  }
  if (report.rates !== undefined && report.rates.n !== report.rows.length) {
    throw new RangeError(`${label} report rates.n does not match its component rows`);
  }
  for (const [index, row] of report.rows.entries()) {
    if (row === null || typeof row !== 'object' || typeof row.sessionId !== 'string' || typeof row.targetPath !== 'string') {
      throw new TypeError(`${label} row ${index} must identify sessionId and targetPath`);
    }
    if (typeof row[metric] !== 'boolean') {
      throw new TypeError(`${label} row ${index} is missing boolean ${metric} outcome`);
    }
  }
}

function indexRows(rows, label) {
  const indexed = new Map();
  for (const row of rows) {
    const id = `${row.sessionId}\0${row.targetPath}`;
    if (indexed.has(id)) throw new RangeError(`${label} report has duplicate component ${row.sessionId} ${row.targetPath}`);
    indexed.set(id, row);
  }
  return indexed;
}

function exactBinomialTwoSided(lowerTailCount, trials) {
  // Sum from the observed tail using log probabilities to remain stable for
  // larger paired datasets. Under H0, discordant outcomes are equiprobable.
  let logProbability = logBinomialProbability(lowerTailCount, trials);
  let tail = Math.exp(logProbability);
  for (let k = lowerTailCount; k > 0; k -= 1) {
    logProbability += Math.log(k) - Math.log(trials - k + 1);
    tail += Math.exp(logProbability);
  }
  return Math.min(1, 2 * tail);
}

function logBinomialProbability(k, n) {
  let logCombination = 0;
  for (let i = 1; i <= k; i += 1) {
    logCombination += Math.log(n - k + i) - Math.log(i);
  }
  return logCombination - n * Math.LN2;
}

function assertCount(successes, observations) {
  if (!Number.isInteger(observations) || observations < 0) {
    throw new RangeError('observations must be a non-negative integer');
  }
  if (!Number.isInteger(successes) || successes < 0 || successes > observations) {
    throw new RangeError('successes must be an integer between zero and observations');
  }
}

function assertPositiveFinite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}
