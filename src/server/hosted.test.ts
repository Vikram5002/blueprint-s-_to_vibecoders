import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createUsage, hostedGuard, ownKeyMiddleware, readHostedConfig, type HostedConfig } from './hosted.js';
import { requestOwner } from './request-owner.js';
import { requestProvider } from '../llm/request-provider.js';

const CONFIG: HostedConfig = { accessCode: 'let-me-in-123', dailyRuns: 2, monthlyRuns: 3, trustProxy: true };
const OWNER = 'browser-0123456789abcdef';

function app(config = CONFIG, now = () => new Date('2026-10-04T10:00:00Z')) {
  const usage = createUsage(config);
  const hono = new Hono();
  hono.use('*', hostedGuard(config, usage, now));
  hono.use('*', ownKeyMiddleware());
  hono.get('/workspace.html', (c) => c.text('ui'));
  hono.get('/api/summary', (c) => c.json({ owner: requestOwner() }));
  hono.post('/api/workflow/jobs', (c) => c.json({ owner: requestOwner(), provider: requestProvider()?.name ?? null }, 202));
  hono.post('/api/workflow/application-jobs/abc/repair', (c) => c.json({}, 202));
  hono.post('/api/workflow/import', (c) => c.json({}));
  hono.get('/api/projects', (c) => c.json({}));
  hono.post('/api/providers', (c) => c.json({}));
  return hono;
}

function headers(extra: Record<string, string> = {}, visitor = '203.0.113.7'): Record<string, string> {
  return { 'x-vibe-access': CONFIG.accessCode, 'x-vibe-owner': OWNER, 'x-forwarded-for': visitor, host: 'vibe.example.org', ...extra };
}

describe('readHostedConfig', () => {
  it('needs an access code of at least 8 characters, and reads the limits', () => {
    expect(readHostedConfig({}).ok).toBe(false);
    expect(readHostedConfig({ VIBE_ACCESS_CODE: 'short' }).ok).toBe(false);
    expect(readHostedConfig({ VIBE_ACCESS_CODE: 'long-enough', VIBE_DAILY_RUNS: 'x' }).ok).toBe(false);
    expect(readHostedConfig({ VIBE_ACCESS_CODE: 'long-enough' })).toEqual({
      ok: true,
      value: { accessCode: 'long-enough', dailyRuns: 5, monthlyRuns: 300, trustProxy: false },
    });
    const custom = readHostedConfig({ VIBE_ACCESS_CODE: 'long-enough', VIBE_DAILY_RUNS: '0', VIBE_MONTHLY_RUNS: '50', VIBE_TRUST_PROXY: '1' });
    expect(custom.ok && custom.value).toMatchObject({ dailyRuns: 0, monthlyRuns: 50, trustProxy: true });
  });
});

describe('hostedGuard', () => {
  it('serves the UI without a code, and tells it what to ask for', async () => {
    const hono = app();
    expect((await hono.request('/workspace.html')).status).toBe(200);
    const info = await hono.request('/api/hosted', { headers: { host: 'vibe.example.org' } });
    expect(await info.json()).toMatchObject({ hosted: true, accessOk: false, usedToday: null, ownKeyProviders: expect.arrayContaining(['groq', 'gemini']) });
    const ok = await hono.request('/api/hosted', { headers: headers() });
    expect(await ok.json()).toMatchObject({ accessOk: true, usedToday: 0, dailyRuns: 2, monthlyLeft: 3 });
  });

  it('refuses every API call without the right code', async () => {
    const hono = app();
    const none = await hono.request('/api/summary', { headers: { host: 'vibe.example.org', 'x-vibe-owner': OWNER } });
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ needsAccessCode: true });
    expect((await hono.request('/api/summary', { headers: headers({ 'x-vibe-access': 'let-me-in-124' }) })).status).toBe(401);
  });

  it('refuses another website, and accepts its own', async () => {
    const hono = app();
    expect((await hono.request('/api/summary', { headers: headers({ origin: 'https://evil.example' }) })).status).toBe(403);
    expect((await hono.request('/api/summary', { headers: headers({ origin: 'https://vibe.example.org' }) })).status).toBe(200);
  });

  it('blocks what would read or change the server\'s own files and settings', async () => {
    const hono = app();
    expect((await hono.request('/api/projects', { headers: headers() })).status).toBe(403);
    expect((await hono.request('/api/workflow/import', { method: 'POST', headers: headers() })).status).toBe(403);
    expect((await hono.request('/api/providers', { method: 'POST', headers: headers() })).status).toBe(403);
  });

  it('needs a browser id, and makes it the owner of whatever the request does', async () => {
    const hono = app();
    expect((await hono.request('/api/summary', { headers: headers({ 'x-vibe-owner': 'bad' }) })).status).toBe(400);
    expect(await (await hono.request('/api/summary', { headers: headers() })).json()).toEqual({ owner: OWNER });
  });

  it('limits runs on the shared model per visitor per day, counting only accepted ones', async () => {
    const hono = app();
    const run = (visitor: string) => hono.request('/api/workflow/jobs', { method: 'POST', headers: headers({}, visitor) });
    expect((await run('203.0.113.7')).status).toBe(202);
    expect((await hono.request('/api/workflow/application-jobs/abc/repair', { method: 'POST', headers: headers() })).status).toBe(202);
    const third = await run('203.0.113.7');
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ needsOwnKey: true });
    // Another visitor has their own allowance - until the monthly cap (3) is reached.
    expect((await run('198.51.100.1')).status).toBe(202);
    const capped = await run('198.51.100.2');
    expect(capped.status).toBe(429);
    expect((await capped.json()) as { error: string }).toMatchObject({ error: expect.stringContaining('monthly') });
  });

  it('a new day resets the visitor\'s count', async () => {
    let now = new Date('2026-10-04T23:00:00Z');
    const hono = app({ ...CONFIG, monthlyRuns: 100 }, () => now);
    const run = () => hono.request('/api/workflow/jobs', { method: 'POST', headers: headers() });
    await run();
    await run();
    expect((await run()).status).toBe(429);
    now = new Date('2026-10-05T01:00:00Z');
    expect((await run()).status).toBe(202);
  });

  it('does not limit a visitor who brings their own key, and runs their request on it', async () => {
    const hono = app({ ...CONFIG, dailyRuns: 0 });
    const shared = await hono.request('/api/workflow/jobs', { method: 'POST', headers: headers() });
    expect(shared.status).toBe(429);
    const own = await hono.request('/api/workflow/jobs', {
      method: 'POST',
      headers: headers({ 'x-vibe-provider': 'groq', 'x-vibe-api-key': 'gsk_visitor_key_123456' }),
    });
    expect(own.status).toBe(202);
    expect(await own.json()).toMatchObject({ owner: OWNER, provider: expect.stringMatching(/^groq:/) });
  });

  it('rejects an own key that cannot be used, naming the reason', async () => {
    const hono = app();
    const bad = await hono.request('/api/workflow/jobs', {
      method: 'POST',
      headers: headers({ 'x-vibe-provider': 'ollama', 'x-vibe-api-key': 'whatever-123456' }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/^your API key: /);
  });
});
