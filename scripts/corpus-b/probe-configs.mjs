/**
 * Verifies, by real HTTP, which candidate repositories ship a machine-checkable
 * architecture-rule config. Same method as corpus A: fetch the raw file.
 */
import { writeFileSync } from 'node:fs';

const BRANCHES = ['main', 'master'];

// dependency-cruiser / eslint-plugin-boundaries (JS/TS) and import-linter (Python).
const JS_PATHS = [
  '.dependency-cruiser.js', '.dependency-cruiser.cjs', '.dependency-cruiser.mjs',
  '.dependency-cruiser.json', '.dependency-cruiser.jsonc',
  'dependency-cruiser.config.js', 'dependency-cruiser.config.mjs', 'dependency-cruiser.config.cjs',
];
const PY_PATHS = ['.importlinter', 'setup.cfg', 'pyproject.toml', 'tox.ini', '.import-linter', 'importlinter.ini'];
const ESLINT_PATHS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts', 'eslint.config.cjs',
  '.eslintrc.js', '.eslintrc.json', '.eslintrc.cjs', '.eslintrc.yml', '.eslintrc.yaml', '.eslintrc'];

const CANDIDATES = JSON.parse(process.argv[2]);

async function fetchRaw(repo, branch, path) {
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

/** A hit only counts if the file's *content* proves the tool is configured. */
function classify(path, body) {
  if (body === null) return null;
  if (/dependency-cruiser/i.test(path)) return { tool: 'dependency-cruiser', confirmedBy: 'filename' };
  if (path === '.importlinter') return { tool: 'import-linter', confirmedBy: 'filename' };
  if (/setup\.cfg|tox\.ini/.test(path) && /\[importlinter/i.test(body)) {
    return { tool: 'import-linter', confirmedBy: 'section header' };
  }
  if (path === 'pyproject.toml' && /\[tool\.importlinter/i.test(body)) {
    return { tool: 'import-linter', confirmedBy: 'section header' };
  }
  if (/eslint/.test(path) && /boundaries\//.test(body)) {
    return { tool: 'eslint-plugin-boundaries', confirmedBy: 'rule prefix in config' };
  }
  return null;
}

const results = [];
for (const { repo, lang } of CANDIDATES) {
  const paths = lang === 'python' ? PY_PATHS : [...JS_PATHS, ...ESLINT_PATHS];
  let found = null;
  outer: for (const branch of BRANCHES) {
    for (const path of paths) {
      const body = await fetchRaw(repo, branch, path);
      const hit = classify(path, body);
      if (hit) { found = { ...hit, branch, path, bytes: body.length }; break outer; }
    }
  }
  if (found) {
    console.log(`HIT  ${repo.padEnd(34)} ${found.tool.padEnd(24)} ${found.path} (${found.branch})`);
    results.push({ repo, lang, ...found });
  } else {
    console.log(`  -  ${repo}`);
  }
}
writeFileSync(process.argv[3], JSON.stringify(results, null, 2));
console.log(`\n${results.length} of ${CANDIDATES.length} candidates confirmed`);
