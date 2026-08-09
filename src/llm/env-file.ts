/**
 * Minimal `.env` reader.
 *
 * Fifteen lines instead of a dependency. CLAUDE.md says not to install heavy
 * dependencies without asking, and startup time matters for a CLI — dotenv is
 * not large, but it is a package, a version and a supply-chain edge for
 * something this project needs one function of.
 *
 * `process.loadEnvFile` would do it natively, but it landed in Node 22 and the
 * stated floor is Node 20.
 *
 * ## Secrets discipline
 *
 * Values parsed here are API keys. Nothing in this file logs, returns or
 * formats a value for display, and callers get them only through
 * `process.env`. `describeKeySource` exists so the CLI can say *where* a key
 * came from without ever saying what it is.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * Loads `.env` into `process.env` without overwriting anything already set.
 *
 * A real environment variable always wins. Someone running
 * `GEMINI_API_KEY=... vibe-blueprint` is being explicit, and a stale file
 * silently overriding that would be the wrong way round.
 */
export function loadEnvFile(root: string, env: NodeJS.ProcessEnv = process.env): readonly string[] {
  let text: string;
  try {
    text = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    // No .env is the normal case, not an error.
    return [];
  }

  const loaded: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const match = KEY_LINE.exec(line);
    if (match === null) continue;

    const name = match[1] as string;
    if (env[name] !== undefined) continue;

    let value = (match[2] ?? '').trim();
    // Strip one layer of matching quotes; leave anything else alone.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    env[name] = value;
    // Names only. A value never leaves this function.
    loaded.push(name);
  }

  return loaded;
}

/**
 * Where a key came from, for a status line. Never returns the key, any prefix
 * of it, or its length — a length is a small leak and it buys nothing.
 */
export function describeKeySource(name: string, fromFile: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  if (env[name] === undefined || env[name]?.trim() === '') return 'not set';
  return fromFile.includes(name) ? 'from .env' : 'from the environment';
}
