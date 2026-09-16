import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { createSettingsStore } from './settings-store.js';

describe('createSettingsStore', () => {
  it('returns null for a key that was never set', () => {
    const store = createSettingsStore(openDatabase(':memory:'));
    expect(store.get('llm.provider')).toBeNull();
  });

  it('round-trips a value', () => {
    const store = createSettingsStore(openDatabase(':memory:'));
    store.set('llm.provider', 'local');
    expect(store.get('llm.provider')).toBe('local');
  });

  it('overwrites on re-set rather than accumulating rows - last write wins', () => {
    const db = openDatabase(':memory:');
    const store = createSettingsStore(db);
    store.set('llm.provider', 'gemini');
    store.set('llm.provider', 'local');

    expect(store.get('llm.provider')).toBe('local');
    const count = db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('keeps distinct keys independent', () => {
    const store = createSettingsStore(openDatabase(':memory:'));
    store.set('a', '1');
    store.set('b', '2');
    expect([store.get('a'), store.get('b')]).toEqual(['1', '2']);
  });
});
