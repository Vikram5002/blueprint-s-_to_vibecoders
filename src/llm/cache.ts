/**
 * Response cache, keyed by a hash of the exact input sent.
 *
 * "Cache all responses keyed by input hash. Re-runs on an unchanged repo should
 * cost nothing" (docs/ARCHITECTURE.md). Cost is only half of it: because
 * clustering is deterministic, an unchanged repository produces byte-identical
 * prompts, so a cache hit also makes the labels themselves reproducible. The
 * model is consulted once per distinct cluster, ever — which is a stronger
 * reproducibility guarantee than any sampling parameter could give.
 *
 * The key covers everything that could change the answer: model, system prompt,
 * user prompt, and the schema. Change the prompt wording and every entry misses,
 * correctly — the old answers were to a different question.
 *
 * Stored as one JSON file under `.vibe/`, which is git-ignored by default.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';

export interface CachedLabel {
  readonly label: string;
  readonly description: string | null;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** ISO timestamp, for cache inspection and eviction if it is ever needed. */
  readonly createdAt: string;
}

export interface LabelCache {
  get(key: string): CachedLabel | undefined;
  set(key: string, value: CachedLabel): void;
  /** Persists to disk. A failure is logged by the caller, never fatal. */
  flush(): Promise<boolean>;
  readonly size: number;
}

export const CACHE_VERSION = 1;

/**
 * Everything that could change the answer goes into the key.
 *
 * Fields are joined on NUL, which cannot occur in a model name, a prompt or a
 * schema, so no combination of inputs can collide by running two fields
 * together. Written as a unicode escape rather than the byte itself: a raw
 * control character makes the whole file binary to git and grep, and the escape
 * hashes identically.
 */
export function cacheKey(parts: {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly schema: string;
}): string {
  return createHash('sha256')
    .update(`v${CACHE_VERSION}\u0000${parts.model}\u0000${parts.system}\u0000${parts.user}\u0000${parts.schema}`)
    .digest('hex');
}

interface CacheFile {
  readonly version: number;
  readonly entries: Record<string, CachedLabel>;
}

export function cachePathFor(root: string): string {
  return posix.join(root.replace(/\\/g, '/'), '.vibe', 'label-cache.json');
}

/**
 * Loads the cache. A missing, unreadable or corrupt file is an empty cache, not
 * an error — a broken cache must never stop a run, it just costs a re-ask.
 */
export async function loadLabelCache(root: string): Promise<LabelCache> {
  const path = cachePathFor(root);
  const entries = await readEntries(path);
  let dirty = false;

  return {
    get: (key) => entries.get(key),
    set: (key, value) => {
      entries.set(key, value);
      dirty = true;
    },
    get size() {
      return entries.size;
    },
    flush: async () => {
      if (!dirty) {
        return true;
      }
      const written = await serialised(path, async () => {
        // Several jobs share one cache file, each with its own copy loaded at
        // its start. Merge what the others have saved since, so the last
        // writer does not drop their entries.
        for (const [key, value] of await readEntries(path)) {
          if (!entries.has(key)) entries.set(key, value);
        }
        return writeAtomically(path, entries);
      });
      dirty = !written;
      return written;
    },
  };
}

/** One flush per file at a time, within this process. */
const pendingWrites = new Map<string, Promise<unknown>>();

async function serialised<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = pendingWrites.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  pendingWrites.set(path, next);
  try {
    return await next;
  } finally {
    if (pendingWrites.get(path) === next) pendingWrites.delete(path);
  }
}

async function readEntries(path: string): Promise<Map<string, CachedLabel>> {
  const entries = new Map<string, CachedLabel>();
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw !== null) {
    const parsed = safeParse(raw);
    if (parsed !== null && parsed.version === CACHE_VERSION) {
      for (const [key, value] of Object.entries(parsed.entries)) {
        entries.set(key, value);
      }
    }
  }
  return entries;
}

/** Writes a temporary file and renames it over the cache, so a reader never sees half a file. */
async function writeAtomically(path: string, entries: ReadonlyMap<string, CachedLabel>): Promise<boolean> {
  // Sorted keys so the file is stable between runs and diffs cleanly.
  const sorted = Object.fromEntries([...entries.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  const payload: CacheFile = { version: CACHE_VERSION, entries: sorted };
  const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await mkdir(posix.dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8');
    await rename(temporary, path);
    return true;
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    return false;
  }
}

function safeParse(raw: string): CacheFile | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      'entries' in parsed &&
      typeof (parsed as CacheFile).entries === 'object'
    ) {
      return parsed as CacheFile;
    }
  } catch {
    /* corrupt cache is an empty cache */
  }
  return null;
}
