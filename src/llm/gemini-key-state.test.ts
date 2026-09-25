import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileKeyRotationState, keyListFingerprint, quotaDay } from './gemini-key-state.js';
import { createGeminiProvider } from './gemini.js';

describe('gemini key rotation state across restarts', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vibe-key-state-'));
    path = join(dir, 'state.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('remembers exhausted keys for the same key list and the same quota day', () => {
    const first = createFileKeyRotationState(['k1', 'k2', 'k3'], path);
    first.markExhausted(0);
    first.markExhausted(1);
    // A new process - a fresh state object over the same file.
    const afterRestart = createFileKeyRotationState(['k1', 'k2', 'k3'], path);
    expect([...afterRestart.exhaustedToday()]).toEqual([0, 1]);
  });

  it('forgets everything on a new Pacific quota day', () => {
    createFileKeyRotationState(['k1', 'k2'], path, () => new Date('2026-09-25T12:00:00Z')).markExhausted(0);
    const nextDay = createFileKeyRotationState(['k1', 'k2'], path, () => new Date('2026-09-26T12:00:00Z'));
    expect(nextDay.exhaustedToday().size).toBe(0);
  });

  it('ignores the record when the configured keys change', () => {
    createFileKeyRotationState(['k1', 'k2'], path).markExhausted(0);
    expect(createFileKeyRotationState(['k1', 'k2', 'k9'], path).exhaustedToday().size).toBe(0);
  });

  it('never writes a key to disk - only a fingerprint', async () => {
    createFileKeyRotationState(['secret-key-one', 'secret-key-two'], path).markExhausted(0);
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('secret-key');
    expect(raw).toContain(keyListFingerprint(['secret-key-one', 'secret-key-two']));
  });

  it('uses the Pacific date, which is when the daily quota resets', () => {
    // 06:00 UTC on the 26th is still the 25th in California.
    expect(quotaDay(new Date('2026-09-26T06:00:00Z'))).toBe('2026-09-25');
  });

  it('a restarted provider starts at the first key not used up today, and records a quota rotation', async () => {
    const quotaBody = JSON.stringify({
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: 'Quota exceeded',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
        ],
      },
    });
    const okBody = JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    const usedKeys: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const key = String((init?.headers as Record<string, string>)['x-goog-api-key']);
      usedKeys.push(key);
      return key === 'k1' ? new Response(quotaBody, { status: 429 }) : new Response(okBody, { status: 200 });
    }) as typeof fetch;

    const state = createFileKeyRotationState(['k1', 'k2', 'k3'], path);
    const first = createGeminiProvider({ apiKey: 'k1', additionalApiKeys: ['k2', 'k3'], fetchImpl, keyState: state, sleep: async () => {} });
    expect((await first.complete({ system: 's', user: 'u', maxOutputTokens: 8 })).ok).toBe(true);
    expect(usedKeys[0]).toBe('k1');
    expect(usedKeys.at(-1)).toBe('k2');

    usedKeys.length = 0;
    const restarted = createGeminiProvider({
      apiKey: 'k1',
      additionalApiKeys: ['k2', 'k3'],
      fetchImpl,
      keyState: createFileKeyRotationState(['k1', 'k2', 'k3'], path),
      sleep: async () => {},
    });
    expect((await restarted.complete({ system: 's', user: 'u', maxOutputTokens: 8 })).ok).toBe(true);
    // Straight to key 2: no call wasted on the key already used up today.
    expect(usedKeys).toEqual(['k2']);
  });
});
