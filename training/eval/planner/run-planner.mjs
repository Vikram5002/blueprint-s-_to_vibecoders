// Plans every held-out prompt through the real VibeCoder server with one local planner; writes <out>.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const [cli, workspace, url, out] = process.argv.slice(2);
const E = 'D:/project blue print/training/eval';
const prompts = process.argv[6] ? JSON.parse(readFileSync(process.argv[6], 'utf8')) : [...JSON.parse(readFileSync(`${E}/held-out-prompts.json`, 'utf8')), ...JSON.parse(readFileSync(`${E}/constraint-probe-prompts.json`, 'utf8'))];
mkdirSync(workspace, { recursive: true });
const child = spawn(process.execPath, [cli, workspace, '--no-open'], { cwd: workspace });
const base = await new Promise((res, rej) => {
  let seen = '';
  child.stdout.on('data', (d) => { seen += d; const m = /ready at\s+(http\S+)/.exec(seen); if (m) res(m[1]); });
  child.on('exit', (c) => rej(new Error(`server exited ${c}\n${seen}`)));
});
const api = async (path, body) => {
  const r = await fetch(`${base}/api${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json(); if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j)}`); return j;
};
// Resume after an interruption: keep finished plans, redo only the rest.
const results = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : [];
try {
  await api('/providers', { provider: 'local', codeProvider: 'local-code', localBaseUrl: url, localCodeBaseUrl: url });
  for (const [i, prompt] of prompts.entries()) {
    if (results.some((r) => r.prompt === prompt)) continue;
    const t0 = Date.now();
    let job = await api('/workflow/jobs', { prompt });
    // A dropped poll is retried; only the job's own status ends the wait.
    while (['pending', 'running'].includes(job.status)) {
      await new Promise((r) => setTimeout(r, 3000));
      try { job = await api(`/workflow/jobs/${job.id}`); } catch (e) { console.log(`poll retry: ${e.message}`); }
    }
    const schema = job.result?.schema ?? job.result;
    results.push({ prompt, status: job.status, seconds: Math.round((Date.now() - t0) / 1000), schema: job.status === 'succeeded' ? schema : undefined, error: job.error ?? job.result?.error });
    console.log(`${i + 1}/${prompts.length} ${job.status} ${Math.round((Date.now() - t0) / 1000)}s ${prompt.slice(0, 50)}`);
    writeFileSync(out, JSON.stringify(results, null, 1));
  }
} finally { child.kill(); }
