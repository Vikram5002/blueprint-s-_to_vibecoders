// node --test test/ - installs the bundled package with this computer's npm,
// starts the real server on this computer's Node, and loads the workspace.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureRuntime, nodeMajor, parseReadyUrl, startServer } = require('../server-runner.cjs');

test('reads the address the CLI prints', () => {
  assert.equal(parseReadyUrl('x\n  Blueprint ready at  http://127.0.0.1:5123\n'), 'http://127.0.0.1:5123');
  assert.equal(parseReadyUrl('Scanning'), null);
});

test('finds this computer\'s Node.js', async () => {
  assert.ok((await nodeMajor()) >= 20);
});

test('first launch installs the server, a second launch reuses it, and it serves the workspace', { timeout: 600_000 }, async () => {
  const tarball = path.join(__dirname, '..', 'vendor', fs.readdirSync(path.join(__dirname, '..', 'vendor')).find((n) => n.endsWith('.tgz')));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-desktop-'));
  const runtimeDir = path.join(scratch, 'runtime');
  const folder = path.join(scratch, 'My Projects');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'index.ts'), 'export const x = 1;\n');

  const cli = await ensureRuntime({ tarball, runtimeDir });
  assert.ok(fs.existsSync(cli));
  const started = Date.now();
  assert.equal(await ensureRuntime({ tarball, runtimeDir }), cli);
  assert.ok(Date.now() - started < 2000, 'the second launch does not install again');

  const server = startServer({ cli, folder, timeoutMs: 120_000 });
  try {
    const url = await server.ready;
    const page = await fetch(`${url}/workspace.html`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>VibeCoder<\/title>/);
    assert.equal((await fetch(`${url}/api/summary`)).status, 200);
  } finally {
    server.stop();
    await new Promise((resolve) => setTimeout(resolve, 800));
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
});
