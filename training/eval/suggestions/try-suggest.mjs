// Runs the feature-suggestion step with the local planner on saved plans; prints and saves what comes back.
import { readFileSync, writeFileSync } from 'node:fs';
const D = 'file:///D:/project%20blue%20print/dist';
const { suggestFeatures } = await import(`${D}/workflow/suggest-features.js`);
const { createLocalProvider } = await import(`${D}/llm/local.js`);
const { validateProjectSchema } = await import(`${D}/workflow/validate-project-schema.js`);
const [url, plansFile, out, limit] = process.argv.slice(2);
const provider = createLocalProvider({ baseUrl: url, model: 'local' });
const rows = JSON.parse(readFileSync(plansFile, 'utf8')).filter((r) => r.status === 'succeeded');
const picked = [rows.find((r) => /canteen|tiffin|sweet shop/i.test(r.prompt)), ...rows].filter(Boolean).slice(0, Number(limit));
const results = [];
for (const r of picked) {
  const v = validateProjectSchema(r.schema); if (!v.ok) continue;
  const t0 = Date.now();
  const s = await suggestFeatures(provider, r.prompt, v.value);
  results.push({ prompt: r.prompt, seconds: Math.round((Date.now() - t0) / 1000), ok: s.ok, suggestions: s.ok ? s.value : [], error: s.ok ? undefined : s.error.message });
  console.log(`\n# ${r.prompt.slice(0, 70)} (${results.at(-1).seconds}s)`);
  for (const x of s.ok ? s.value : []) console.log(`  - ${x.title}: ${x.why}`);
  if (!s.ok) console.log('  FAILED', s.error.message);
  writeFileSync(out, JSON.stringify(results, null, 1));
}
