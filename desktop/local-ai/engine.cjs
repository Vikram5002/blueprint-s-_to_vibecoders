const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

function resultFromChat(body, model) {
  const choice = body.choices?.[0];
  if (choice?.finish_reason === 'length') return { ok: false, error: { kind: 'incomplete', message: 'The local model reached its output limit. Try a smaller request.' } };
  const text = choice?.message?.content;
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: { kind: 'refused', message: 'The local model returned no text.' } };
  return { ok: true, value: { text, model, usage: { promptTokens: body.usage?.prompt_tokens ?? 0, completionTokens: body.usage?.completion_tokens ?? 0, cachedPromptTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0 } } };
}

// All requests, including model changes, run through one queue in bridge.cjs.
// This process owns at most one model and one KV cache at a time.
class Engine {
  constructor({ executable, assets, folder, mode, device, layers, models, onStatus = () => {}, spawnImpl = spawn }) {
    Object.assign(this, { executable, assets, folder, mode, device, layers, models, onStatus, spawnImpl });
    this.child = null;
    this.active = null;
    this.closed = false;
  }

  async unload() {
    const child = this.child;
    this.child = null;
    this.active = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
    this.onStatus('Models unloaded. They will load again when needed.');
  }

  stop() { this.closed = true; this.child?.kill(); this.active = null; }

  async load(model, signal) {
    if (this.closed) throw new Error('Local AI has stopped. Reopen Local AI setup to enable it.');
    if (this.active === model.id && this.child?.exitCode === null) return;
    await this.unload();
    signal.throwIfAborted();
    if (this.closed) throw new Error('Local AI has stopped.');
    const port = await unusedPort();
    this.apiKey = crypto.randomUUID();
    this.origin = `http://127.0.0.1:${port}`;
    const layers = this.mode === 'gpu' ? 99 : this.mode === 'hybrid' ? (this.layers ?? 12) : 0;
    const args = ['--model', path.join(this.folder, model.files[0].name), '--lora', path.join(this.assets, model.adapterFile),
      '--host', '127.0.0.1', '--port', String(port), '--api-key', this.apiKey,
      '--ctx-size', '16384', '--parallel', '1', '--n-gpu-layers', String(layers), '--device', layers ? this.device : 'none',
      // On a GPU: flash attention and an 8-bit KV cache free memory for more layers (see hardware.cjs).
      ...(layers ? ['-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0'] : []),
      '--no-webui', '--no-warmup'];
    this.onStatus(`Loading ${model.label} (${this.mode})`);
    const child = this.spawnImpl(this.executable, args, { windowsHide: true, cwd: path.dirname(this.executable), stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let diagnostics = '';
    const collect = (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-3000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let spawnError;
    child.on('error', (error) => { spawnError = error; });
    const deadline = Date.now() + 180_000;
    try {
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (this.closed || child.killed || spawnError || child.exitCode !== null) throw new Error(spawnError?.message ?? `Local runtime stopped. ${diagnostics}`);
        try {
          const health = await fetch(`${this.origin}/health`, { headers: { Authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
          if (health.ok) { this.active = model.id; return; }
        } catch { signal.throwIfAborted(); }
        await delay(300, undefined, { signal });
      }
      throw new Error('Local model loading timed out. Close memory-heavy apps, or select CPU mode.');
    } catch (error) {
      await this.unload();
      // A hybrid load that ran out of graphics memory gets another try with fewer layers on the GPU.
      if (this.mode === 'hybrid' && layers > 8 && !signal.aborted && !this.closed) {
        this.layers = layers - 4;
        this.onStatus(`Retrying with ${this.layers} GPU layers`);
        return this.load(model, signal);
      }
      throw error;
    }
  }

  async complete(request, signal) {
    const model = this.models.find((entry) => entry.id === (request.model ?? 'local'));
    if (!model) throw new Error('Unknown local model');
    await this.load(model, signal);
    const body = { messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
      max_tokens: request.maxOutputTokens, temperature: request.temperature ?? 0,
      ...(request.schema ? { response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: request.schema } } } : {}) };
    this.onStatus(`Running ${model.label} on ${this.mode}`);
    const response = await postJson(`${this.origin}/v1/chat/completions`, body, { Authorization: `Bearer ${this.apiKey}` }, signal);
    if (response.status < 200 || response.status >= 300) throw new Error(`Local runtime HTTP ${response.status}: ${response.text.slice(0, 500)}`);
    const result = resultFromChat(JSON.parse(response.text), `${model.id}:${model.base}+${model.adapter}+gguf-q4_k_m-f16`);
    this.onStatus(`${model.label} is ready in ${this.mode} mode.`);
    return result;
  }
}

// llama-server sends nothing until the whole answer is written, which on a hybrid
// laptop can pass the 300s after which Node's fetch gives up; plain http has no such limit.
function postJson(url, body, headers, signal) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, signal }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

module.exports = { Engine, resultFromChat };
