/**
 * Durable key/value user choices - things a person deliberately picked that
 * are neither analysis output (regenerated every run) nor a correction
 * (which has its own richly-typed store).
 *
 * Deliberately untyped at this layer: it stores strings, and the caller that
 * owns a key owns its meaning and its validation. `provider-registry.ts`
 * validates that its stored provider name is still one this build recognises
 * before acting on it, rather than trusting the database - a value written by
 * an older version, or edited by hand, must never be able to put the process
 * into a state its own types say is impossible.
 */
import type { BlueprintDatabase } from './database.js';

export interface SettingsStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export function createSettingsStore(db: BlueprintDatabase): SettingsStore {
  return {
    get: (key) => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { readonly value: string }
        | undefined;
      return row?.value ?? null;
    },

    set: (key, value) => {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @updatedAt)
         ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @updatedAt`,
      ).run({ key, value, updatedAt: new Date().toISOString() });
    },
  };
}
