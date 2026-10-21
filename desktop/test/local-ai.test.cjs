const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { download } = require('../local-ai/files.cjs');
const { recommendation, parseDevices } = require('../local-ai/hardware.cjs');
const { Engine, resultFromChat } = require('../local-ai/engine.cjs');
const { startBridge } = require('../local-ai/bridge.cjs');
const { connection, restoration } = require('../local-ai/workspace.cjs');

test('reconnecting local AI preserves later cloud choices and stopping restores only managed settings', () => {
  const current = { current: 'gemini', codeProvider: null, localBaseUrl: 'http://old-planner', localCodeBaseUrl: 'http://old-coder' };
  const first = connection(current, undefined, 'http://managed-1');
  assert.equal(first.body.provider, 'local');
  const manual = { ...current, current: 'groq', codeProvider: 'groq', localBaseUrl: 'http://managed-1', localCodeBaseUrl: 'http://managed-1' };
  const restarted = connection(manual, first.saved, 'http://managed-2');
  assert.equal(restarted.body.provider, undefined);
  assert.equal(restarted.body.codeProvider, undefined);
  const restored = restoration({ ...manual, ...restarted.body }, restarted.saved);
  assert.equal(restored.provider, undefined);
  assert.equal(restored.codeProvider, undefined);
  assert.equal(restored.localBaseUrl, current.localBaseUrl);
  const reactivated = connection(manual, first.saved, 'http://managed-3', true);
  assert.equal(reactivated.saved.restore.provider, 'groq');
  assert.equal(reactivated.saved.restore.localBaseUrl, current.localBaseUrl);
  assert.deepEqual(restoration({ ...current, current: 'local', codeProvider: 'local-code', localBaseUrl: 'http://managed-1', localCodeBaseUrl: 'http://managed-1' }, first.saved), { provider: 'gemini', codeProvider: null, localBaseUrl: current.localBaseUrl, localCodeBaseUrl: current.localCodeBaseUrl });
});

test('hardware recommendations distinguish dedicated VRAM from shared RAM and unsupported systems', () => {
  const devices = parseDevices('ggml_vulkan: 0 = Intel UHD (Intel) | uma: 1 | fp16: 1\nggml_vulkan: 1 = NVIDIA (NVIDIA) | uma: 0 | fp16: 1\nAvailable devices:\n Vulkan0: Intel UHD (8042 MiB, 7384 MiB free)\n Vulkan1: NVIDIA GTX 1650 (4152 MiB, 3553 MiB free)\n');
  const facts = { platform: 'win32', arch: 'x64', ramGB: 15.7, runtimeOK: true, devices };
  assert.equal(recommendation(facts).mode, 'hybrid');
  assert.equal(recommendation(facts).device, 'Vulkan1');
  assert.equal(recommendation({ ...facts, devices: devices.slice(0, 1) }).mode, 'cpu');
  assert.equal(recommendation({ ...facts, devices: [{ id: 'Vulkan0', shared: false, memoryMB: 24576 }] }).mode, 'gpu');
  for (const extra of [{ ramGB: 8 }, { arch: 'arm64' }, { runtimeOK: false }]) assert.equal(recommendation({ ...facts, ...extra }).supported, false);
});

test('downloads resume, verify, recover when Range is ignored, and preserve existing mismatched files', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-model-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const data = Buffer.from('this is a model fixture');
  const entry = { name: 'fixture.gguf', bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  let ignoreRange = false;
  let corrupt = false;
  let seenRange;
  const server = http.createServer((req, res) => {
    seenRange = req.headers.range;
    const offset = ignoreRange ? 0 : Number(req.headers.range?.match(/\d+/)?.[0] ?? 0);
    res.writeHead(offset ? 206 : 200, offset ? { 'Content-Range': `bytes ${offset}-${data.length - 1}/${data.length}` } : {});
    res.end(corrupt ? Buffer.alloc(data.length, 'x') : data.subarray(offset));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  entry.url = `http://127.0.0.1:${server.address().port}`;
  const target = path.join(folder, entry.name);
  fs.writeFileSync(target + '.part', data.subarray(0, 5));
  await download(entry, folder);
  assert.equal(seenRange, 'bytes=5-');
  assert.deepEqual(fs.readFileSync(target), data);
  fs.unlinkSync(target);
  fs.writeFileSync(target + '.part', data.subarray(0, 6));
  ignoreRange = true;
  await download(entry, folder);
  assert.deepEqual(fs.readFileSync(target), data);
  fs.writeFileSync(target, 'user file');
  await assert.rejects(download(entry, folder), /wrong checksum/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'user file');
  fs.unlinkSync(target);
  corrupt = true;
  await assert.rejects(download(entry, folder), /Checksum failed/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(target + '.part'), false);
});

test('cancelled downloads remain resumable and do not get a final filename', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cancel-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const controller = new AbortController();
  const entry = { name: 'cancel.gguf', bytes: 10, sha256: 'unused', url: 'https://unused.invalid' };
  await assert.rejects(download(entry, folder, { signal: controller.signal,
    fetchImpl: async () => ({ ok: true, status: 200, body: (async function* () { yield Buffer.from('12345'); controller.abort(); yield Buffer.from('67890'); })() }),
  }));
  assert.equal(fs.readFileSync(path.join(folder, 'cancel.gguf.part'), 'utf8'), '12345');
  assert.equal(fs.existsSync(path.join(folder, 'cancel.gguf')), false);
});

const models = ['local', 'local-code'].map((id) => ({ id, label: id, base: id + '-base', adapter: id + '-adapter', adapterFile: id + '.gguf', files: [{ name: id + '-base.gguf' }] }));

test('bridge serializes model calls, rejects cross-origin requests, propagates failure, and unloads idle models', async (t) => {
  let running = 0;
  let maximum = 0;
  let unloaded = 0;
  let stopped = false;
  const engine = { async complete(req) { running++; maximum = Math.max(maximum, running); await delay(30); running--; if (req.user === 'fail') throw new Error('out of memory'); return { ok: true, value: { text: req.model } }; }, async unload() { unloaded++; }, stop() { stopped = true; } };
  const bridge = await startBridge(engine, models, { idleMs: 20 });
  t.after(() => bridge.stop());
  const post = (body, headers = {}) => fetch(bridge.url + '/complete', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ system: 's', user: 'u', maxOutputTokens: 8192, ...body }) });
  const listed = await (await fetch(bridge.url + '/models')).json();
  assert.match(listed.models[0].label, /gguf-q4_k_m-f16/);
  assert.equal((await post({}, { Origin: 'https://example.com' })).status, 403);
  const results = await Promise.all(['local', 'local-code'].map(async (model) => (await post({ model })).json()));
  assert.deepEqual(results.map((r) => r.value.text), ['local', 'local-code']);
  assert.equal(maximum, 1);
  const failed = await (await post({ user: 'fail' })).json();
  assert.equal(failed.ok, false);
  assert.match(failed.error.message, /out of memory/);
  const invalid = await (await post({ maxOutputTokens: 0 })).json();
  assert.equal(invalid.ok, false);
  await delay(50);
  assert.ok(unloaded >= 1);
  bridge.stop();
  assert.equal(stopped, true);
});

test('bridge sends headers at once and keeps a slow reply alive with whitespace', async (t) => {
  const engine = { async complete() { await delay(120); return { ok: true, value: { text: 'done' } }; }, async unload() {}, stop() {} };
  const bridge = await startBridge(engine, models, { heartbeatMs: 25 });
  t.after(() => bridge.stop());
  const started = Date.now();
  const response = await fetch(bridge.url + '/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system: 's', user: 'u', maxOutputTokens: 10 }) });
  assert.ok(Date.now() - started < 100, 'headers arrive before the model finishes');
  const text = await response.text();
  assert.match(text, /^ +\{/);
  assert.equal(JSON.parse(text).value.text, 'done');
});

test('engine reuses one process, kills it before switching models, and maps schema and token failures', async (t) => {
  const children = [];
  const engine = new Engine({ executable: process.execPath, assets: os.tmpdir(), folder: os.tmpdir(), mode: 'cpu', models,
    spawnImpl: (_exe, args, options) => { const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'fake-llama.cjs'), ...args], options); children.push({ child, args }); return child; } });
  t.after(() => engine.stop());
  const signal = AbortSignal.timeout(15_000);
  const request = { system: 'system', user: 'user', maxOutputTokens: 8192, schema: { type: 'object' } };
  const first = await engine.complete({ ...request, model: 'local' }, signal);
  assert.equal(first.ok, true);
  assert.equal(JSON.parse(first.value.text).response_format.type, 'json_schema');
  await engine.complete({ ...request, model: 'local' }, signal);
  assert.equal(children.length, 1);
  await engine.complete({ ...request, model: 'local-code' }, signal);
  assert.equal(children.length, 2);
  assert.ok(children[0].child.exitCode !== null || children[0].child.signalCode !== null);
  assert.equal(children[1].args[children[1].args.indexOf('--device') + 1], 'none');
  await engine.unload();
  assert.equal(engine.active, null);
  assert.equal(resultFromChat({ choices: [{ finish_reason: 'length' }] }, 'm').error.kind, 'incomplete');
  assert.equal(resultFromChat({ choices: [{ message: { content: '' } }] }, 'm').error.kind, 'refused');
});
