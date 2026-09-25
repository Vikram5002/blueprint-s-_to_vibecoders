/**
 * Remembers, across restarts, which Gemini keys have run out of their daily
 * quota today.
 *
 * Rotation state used to live only in the provider's closure, on the theory
 * that one process lasts as long as a quota day. It does not: stopping the
 * server with Ctrl+C and starting it again reset rotation to key 1, and the
 * next generation spent its first calls rediscovering that key 1 was
 * exhausted (found live, 2026-09-25).
 *
 * What is stored is deliberately minimal: a fingerprint of the configured key
 * list (a hash - never a key), the quota day, and the positions of the keys
 * that hit their daily quota. A different key list or a new quota day makes
 * the record irrelevant, so it is simply ignored. Only daily-quota exhaustion
 * is recorded; a transient failure (a run of 503s) must never keep a healthy
 * key out of use for the rest of the day.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface KeyRotationState {
  /** Key positions already exhausted for today's quota, for this exact key list. */
  exhaustedToday(): ReadonlySet<number>;
  markExhausted(index: number): void;
}

interface StoredState {
  readonly fingerprint: string;
  readonly day: string;
  readonly exhausted: readonly number[];
}

export const DEFAULT_KEY_STATE_PATH = join(homedir(), '.vibe-blueprint', 'gemini-key-state.json');

/** Gemini's free-tier daily quota resets at midnight Pacific time, so "today" is the Pacific date. */
export function quotaDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now);
}

export function keyListFingerprint(keys: readonly string[]): string {
  return createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 16);
}

export function createFileKeyRotationState(
  keys: readonly string[],
  path: string = DEFAULT_KEY_STATE_PATH,
  now: () => Date = () => new Date(),
): KeyRotationState {
  const fingerprint = keyListFingerprint(keys);

  function read(): StoredState | null {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredState>;
      if (parsed.fingerprint !== fingerprint || parsed.day !== quotaDay(now()) || !Array.isArray(parsed.exhausted)) return null;
      return parsed as StoredState;
    } catch {
      return null;
    }
  }

  return {
    exhaustedToday: () => new Set(read()?.exhausted ?? []),
    markExhausted: (index) => {
      const current = read();
      const exhausted = [...new Set([...(current?.exhausted ?? []), index])].sort((a, b) => a - b);
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ fingerprint, day: quotaDay(now()), exhausted } satisfies StoredState), 'utf8');
      } catch {
        // Losing this record only costs one wasted call after a restart; it
        // must never turn a successful rotation into a failed request.
      }
    },
  };
}
