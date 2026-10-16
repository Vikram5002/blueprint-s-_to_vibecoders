const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LocalAI } = require('../local-ai/controller.cjs');

function fixture(t, failCode = false) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-setup-'));
  let settings = {};
  const hash = crypto.createHash('sha256').update('fixture').digest('hex');
  const models = ['local', 'local-code'].map((id) => ({ id, label: id, adapter: id, base: id, adapterFile: id + '.gguf', adapterSha256: hash,
    files: [{ name: id + '.gguf', bytes: 7, sha256: hash, url: 'https://unused.invalid' }] }));
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ models }));
  for (const model of models) fs.writeFileSync(path.join(folder, model.adapterFile), 'fixture');
  const calls = [];
  let stopped = false;
  const controller = new LocalAI({ assets: folder, defaultFolder: folder, readSettings: () => settings, writeSettings: (value) => { settings = value; },
    createEngine: () => ({ async complete(request) { calls.push(request.model); if (failCode && request.model === 'local-code') throw new Error('GPU allocation failed'); return { ok: true, value: { text: 'ready' } }; }, async unload() {}, stop() { stopped = true; } }) });
  controller.inspect = async () => { controller.update({ hardware: { recommendation: { supported: true, mode: 'cpu' } } }); return controller.state; };
  t.after(() => { controller.stop(); fs.rmSync(folder, { recursive: true, force: true }); });
  return { folder, controller, calls, settings: () => settings, stopped: () => stopped };
}

test('setup enables only after both models pass, and verified restart does not repeat generation', async (t) => {
  const f = fixture(t);
  const url = await f.controller.setup({ importOnly: true, onReady: async () => {
    assert.equal(f.controller.state.busy, true);
    assert.equal(f.controller.state.enabled, false);
    assert.equal(f.settings().localAI, undefined);
    assert.equal((await fetch(f.controller.bridge.url + '/models')).status, 200);
  } });
  assert.deepEqual(f.calls, ['local', 'local-code']);
  assert.equal(f.settings().localAI.enabled, true);
  assert.equal(f.controller.state.busy, false);
  assert.equal((await fetch(url + '/models')).status, 200);
  await f.controller.setup({ importOnly: true, testModels: false });
  assert.equal(f.calls.length, 2);
});

test('failed second-model load leaves setup disabled, stops the engine and reports the failure', async (t) => {
  const f = fixture(t, true);
  await assert.rejects(f.controller.setup({ importOnly: true }), /GPU allocation/);
  assert.equal(f.controller.state.enabled, false);
  assert.equal(f.controller.state.busy, false);
  assert.equal(f.settings().localAI, undefined);
  assert.equal(f.stopped(), true);
});

test('bad adapters and low disk space fail before enabling or starting inference', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.folder, 'local.gguf'), 'damaged');
  await assert.rejects(f.controller.setup({ importOnly: true }), /adapter checksum/);
  assert.deepEqual(f.calls, []);
  f.controller.manifest.models[0].files[0].bytes = Number.MAX_SAFE_INTEGER;
  await assert.rejects(f.controller.setup({ importOnly: true }), /disk space/);
  assert.deepEqual(f.calls, []);
});
