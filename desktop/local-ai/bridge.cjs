const http = require('node:http');
const crypto = require('node:crypto');

function validRequest(body) {
  return body && typeof body.system === 'string' && typeof body.user === 'string'
    && Number.isInteger(body.maxOutputTokens) && body.maxOutputTokens > 0 && body.maxOutputTokens <= 8192
    && (body.temperature === undefined || (Number.isFinite(body.temperature) && body.temperature >= 0 && body.temperature <= 2))
    && (body.model === undefined || ['local', 'local-code'].includes(body.model))
    && (body.schema === undefined || (body.schema !== null && typeof body.schema === 'object' && !Array.isArray(body.schema)));
}

async function startBridge(engine, models, { timeoutMs = 890_000, idleMs = 5 * 60_000 } = {}) {
  const token = crypto.randomUUID();
  let queue = Promise.resolve();
  let waiting = 0;
  let stopped = false;
  let idleTimer;
  const controllers = new Set();
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); } };
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${server.address()?.port}` || !req.url?.startsWith(`/${token}/`)) { reply(403, { error: 'Forbidden' }); return; }
    const route = req.url.slice(token.length + 1);
    if (req.method === 'GET' && route === '/models') { reply(200, { models: models.map((m) => ({ name: m.id, base: m.base, adapter: m.adapter + '+gguf-q4_k_m-f16', label: `${m.id}:${m.base}+${m.adapter}+gguf-q4_k_m-f16` })), default: 'local' }); return; }
    if (req.method !== 'POST' || route !== '/complete') { reply(404, { error: 'Not found' }); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) { reply(415, { error: 'Expected JSON' }); return; }
    if (waiting >= 2) { reply(200, { ok: false, error: { kind: 'unavailable', message: 'Local AI is busy. Wait for the current request to finish.', retryable: true } }); return; }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    controllers.add(controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    waiting++;
    clearTimeout(idleTimer);
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('Request too large');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!validRequest(body)) throw new Error('Invalid local request. Output limit must be between 1 and 8192 tokens.');
      const task = queue.then(async () => { signal.throwIfAborted(); if (stopped) throw new Error('Local AI stopped'); return engine.complete(body, signal); });
      queue = task.catch(() => {});
      const result = await task;
      reply(200, result);
    } catch (error) {
      reply(200, { ok: false, error: { kind: 'unavailable', message: error.message, retryable: false } });
    } finally {
      controllers.delete(controller);
      waiting--;
      if (!waiting && !stopped) idleTimer = setTimeout(() => { queue = queue.then(() => engine.unload()).catch(() => {}); }, idleMs);
    }
  });
  server.requestTimeout = timeoutMs;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/${token}`,
    stop() { stopped = true; clearTimeout(idleTimer); controllers.forEach((c) => c.abort()); engine.stop(); server.closeAllConnections(); server.close(); },
  };
}

module.exports = { startBridge, validRequest };
