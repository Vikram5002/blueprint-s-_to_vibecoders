// Scores each planner's held-out plans: valid, and complete (3+ pages, an API, tables, API linked to tables).
import { existsSync, readFileSync } from 'node:fs';
const dir = process.argv[2];
const rows = [];
for (const name of ['p91', 'p288', 'p563']) {
  const file = `${dir}/${name}.json`;
  if (!existsSync(file)) continue;
  const results = JSON.parse(readFileSync(file, 'utf8'));
  let valid = 0, complete = 0, linked = 0, rules = 0, pages = 0, secs = 0;
  for (const r of results) {
    secs += r.seconds;
    if (r.status !== 'succeeded' || !r.schema?.domains) continue;
    valid++;
    const d = r.schema.domains;
    const count = (k) => d[k]?.components?.length ?? 0;
    const link = (d.backend?.dependsOn ?? []).includes('database');
    pages += count('frontend');
    if (link) linked++;
    if ((r.schema.constraints ?? []).length > 0) rules++;
    if (count('frontend') >= 3 && count('backend') >= 1 && count('database') >= 1 && link) complete++;
  }
  const n = results.length;
  rows.push({ planner: name, plans: n, valid, complete, apiLinkedToTables: linked, withRules: rules, avgPages: +(pages / Math.max(valid, 1)).toFixed(1), avgSeconds: Math.round(secs / n) });
}
console.table(rows);
