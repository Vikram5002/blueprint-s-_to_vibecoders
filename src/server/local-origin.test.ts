import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { localOriginOnly } from './local-origin.js';

function app(): Hono {
  const hono = new Hono();
  hono.use('*', localOriginOnly());
  hono.get('/api/ping', (c) => c.json({ ok: true }));
  hono.post('/api/do', (c) => c.json({ ok: true }));
  return hono;
}

describe('localOriginOnly', () => {
  it('lets same-machine requests through', async () => {
    expect((await app().request('http://127.0.0.1:4000/api/ping')).status).toBe(200);
    expect((await app().request('http://localhost:4000/api/ping')).status).toBe(200);
  });

  it('accepts a loopback page on another port, such as the Vite dev server', async () => {
    const response = await app().request('http://127.0.0.1:4000/api/do', {
      method: 'POST',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.status).toBe(200);
  });

  it('refuses a cross-site POST, even a text/plain one that needs no preflight', async () => {
    const response = await app().request('http://127.0.0.1:4000/api/do', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: '{"url":"https://github.com/a/b"}',
    });
    expect(response.status).toBe(403);
  });

  it('refuses an opaque origin', async () => {
    const response = await app().request('http://127.0.0.1:4000/api/do', { method: 'POST', headers: { origin: 'null' } });
    expect(response.status).toBe(403);
  });

  it('refuses a DNS-rebound request addressed to a foreign host name', async () => {
    expect((await app().request('http://attacker.example:4000/api/ping')).status).toBe(403);
  });
});
