/**
 * Hosted mode (`--hosted`): one server for a group of invited people, instead
 * of one per computer. Approved 2026-10-04 as the one exception to
 * "local-first" (CLAUDE.md). It replaces the loopback-only guard with:
 *
 * - an access code (VIBE_ACCESS_CODE) on every API request;
 * - a same-site check, so another website cannot drive a visitor's browser;
 * - no route that reads or changes this server's own files or settings
 *   (switching projects, importing a folder, reworking a file, choosing the
 *   server's model, corrections and blueprint edits to the analysed folder);
 * - an owner per browser (request-owner.ts): each one sees only its own
 *   projects and runs;
 * - a daily limit per visitor, and a monthly cap, on runs that use this
 *   server's own models. A visitor who brings their own key
 *   (request-provider.ts) is not limited - they pay with their own quota.
 *
 * Counters are in memory: a restart resets them, which errs on the side of
 * the visitor, never of the bill (the monthly cap still bounds one process).
 */
import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { providerFromUserKey, runWithRequestProvider, USER_KEY_PROVIDERS } from '../llm/request-provider.js';
import { runAsOwner } from './request-owner.js';
import { type Result, ok, err } from '../types/result.js';

export interface HostedConfig {
  readonly accessCode: string;
  /** Runs per visitor per day on this server's own models; 0 = only visitors' own keys. */
  readonly dailyRuns: number;
  /** Runs per calendar month on this server's own models, for everyone together. */
  readonly monthlyRuns: number;
  /** Behind a reverse proxy (Caddy, nginx): read the visitor's address from X-Forwarded-For. */
  readonly trustProxy: boolean;
}

export const OWN_KEY_HEADERS = { provider: 'x-vibe-provider', apiKey: 'x-vibe-api-key', model: 'x-vibe-model' } as const;
export const ACCESS_HEADER = 'x-vibe-access';
export const OWNER_HEADER = 'x-vibe-owner';

const MIN_ACCESS_CODE = 8;

export function readHostedConfig(env: NodeJS.ProcessEnv): Result<HostedConfig, string> {
  const accessCode = env['VIBE_ACCESS_CODE']?.trim() ?? '';
  if (accessCode.length < MIN_ACCESS_CODE) {
    return err(`hosted mode needs VIBE_ACCESS_CODE set to at least ${MIN_ACCESS_CODE} characters - share it only with the people you invite`);
  }
  const count = (name: string, fallback: number): number | null => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    return /^\d+$/.test(raw) ? Number(raw) : null;
  };
  const dailyRuns = count('VIBE_DAILY_RUNS', 5);
  const monthlyRuns = count('VIBE_MONTHLY_RUNS', 300);
  if (dailyRuns === null || monthlyRuns === null) return err('VIBE_DAILY_RUNS and VIBE_MONTHLY_RUNS must be whole numbers');
  return ok({ accessCode, dailyRuns, monthlyRuns, trustProxy: env['VIBE_TRUST_PROXY'] === '1' });
}

/** Routes that would let a visitor read or change this server's own files, settings or analysed folder. */
const BLOCKED: readonly { readonly method: string; readonly path: RegExp }[] = [
  { method: '*', path: /^\/api\/projects(\/|$)/ },
  { method: '*', path: /^\/api\/rework(\/|$)/ },
  { method: 'POST', path: /^\/api\/workflow\/import$/ },
  { method: 'POST', path: /^\/api\/providers\/?$/ },
  { method: 'POST', path: /^\/api\/corrections$/ },
  { method: 'DELETE', path: /^\/api\/corrections\// },
  { method: 'POST', path: /^\/api\/blueprint\/(save|accept-seeds)$/ },
];

/** Requests that start model calls - what the daily limit counts. */
const MODEL_RUNS: readonly RegExp[] = [
  /^\/api\/workflow\/jobs$/,
  /^\/api\/workflow\/application-jobs$/,
  /^\/api\/workflow\/application-jobs\/[^/]+\/(components|continue|repair|pages\/sync)$/,
  /^\/api\/page-builder\/(design|generate)$/,
];

const OWNER_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface Usage {
  readonly dailyRuns: number;
  readonly monthlyRuns: number;
  usedToday(visitor: string, now: Date): number;
  usedThisMonth(now: Date): number;
  record(visitor: string, now: Date): void;
}

export function createUsage(config: Pick<HostedConfig, 'dailyRuns' | 'monthlyRuns'>): Usage {
  const daily = new Map<string, { day: string; count: number }>();
  let monthly = { month: '', count: 0 };
  const day = (now: Date): string => now.toISOString().slice(0, 10);
  const month = (now: Date): string => now.toISOString().slice(0, 7);
  return {
    dailyRuns: config.dailyRuns,
    monthlyRuns: config.monthlyRuns,
    usedToday: (visitor, now) => {
      const entry = daily.get(visitor);
      return entry !== undefined && entry.day === day(now) ? entry.count : 0;
    },
    usedThisMonth: (now) => (monthly.month === month(now) ? monthly.count : 0),
    record: (visitor, now) => {
      const today = day(now);
      const entry = daily.get(visitor);
      daily.set(visitor, { day: today, count: entry !== undefined && entry.day === today ? entry.count + 1 : 1 });
      monthly = monthly.month === month(now) ? { month: monthly.month, count: monthly.count + 1 } : { month: month(now), count: 1 };
      if (daily.size > 10_000) for (const [key, value] of daily) if (value.day !== today) daily.delete(key);
    },
  };
}

function visitorAddress(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded !== undefined && forwarded !== '') return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The host a request was addressed to, as the browser saw it. */
function requestHost(c: Context, trustProxy: boolean): string {
  const forwarded = trustProxy ? c.req.header('x-forwarded-host') : undefined;
  return (forwarded ?? c.req.header('host') ?? new URL(c.req.url).host).toLowerCase();
}

/**
 * Replaces localOriginOnly() in hosted mode. Static files (the UI itself,
 * including the access-code screen) need no code; every /api route does,
 * except GET /api/hosted, which tells the UI what to ask for.
 */
export function hostedGuard(config: HostedConfig, usage: Usage, now: () => Date = () => new Date()): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    if (!path.startsWith('/api/')) {
      await next();
      return undefined;
    }

    const origin = c.req.header('origin');
    if (origin !== undefined) {
      let originHost = '';
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        originHost = '';
      }
      if (originHost !== requestHost(c, config.trustProxy)) return c.json({ error: 'refused: cross-site request' }, 403);
    }

    const access = c.req.header(ACCESS_HEADER) ?? '';
    const accessOk = sameSecret(access, config.accessCode);
    const visitor = visitorAddress(c, config.trustProxy);

    if (path === '/api/hosted' && c.req.method === 'GET') {
      return c.json({
        hosted: true,
        accessOk,
        ownKeyProviders: USER_KEY_PROVIDERS,
        dailyRuns: usage.dailyRuns,
        usedToday: accessOk ? usage.usedToday(visitor, now()) : null,
        monthlyLeft: accessOk ? Math.max(0, usage.monthlyRuns - usage.usedThisMonth(now())) : null,
      });
    }

    if (!accessOk) return c.json({ error: 'this VibeCoder server needs an access code', needsAccessCode: true }, 401);

    const blocked = BLOCKED.find((rule) => (rule.method === '*' || rule.method === c.req.method) && rule.path.test(path));
    if (blocked !== undefined) return c.json({ error: 'not available on a hosted VibeCoder server - run VibeCoder on your own computer for this' }, 403);

    const owner = c.req.header(OWNER_HEADER) ?? '';
    if (!OWNER_SHAPE.test(owner)) return c.json({ error: 'missing or malformed browser id - reload the page' }, 400);

    const usesSharedModel =
      c.req.method === 'POST' && MODEL_RUNS.some((route) => route.test(path)) && (c.req.header(OWN_KEY_HEADERS.apiKey) ?? '') === '';
    if (usesSharedModel) {
      const at = now();
      if (usage.dailyRuns === 0 || usage.usedToday(visitor, at) >= usage.dailyRuns) {
        return c.json(
          {
            error:
              usage.dailyRuns === 0
                ? 'this server runs only on your own API key - add a free one (Groq or Gemini) in the model menu'
                : `you have used today's ${usage.dailyRuns} free runs on the shared model - add your own free API key (Groq or Gemini) in the model menu to keep going`,
            needsOwnKey: true,
          },
          429,
        );
      }
      if (usage.usedThisMonth(at) >= usage.monthlyRuns) {
        return c.json({ error: "the shared model's monthly allowance is used up - add your own free API key in the model menu", needsOwnKey: true }, 429);
      }
    }

    await runAsOwner(owner, () => next());
    if (usesSharedModel && c.res.status < 300) usage.record(visitor, now());
    return undefined;
  };
}

/**
 * "Use my own key": a request carrying a provider and key runs, with every
 * job it starts, on that key (request-provider.ts). Works on a local install
 * too, so a person can paste a key in the app instead of editing .env.
 */
export function ownKeyMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const apiKey = c.req.header(OWN_KEY_HEADERS.apiKey) ?? '';
    if (apiKey === '' || !c.req.path.startsWith('/api/')) {
      await next();
      return undefined;
    }
    const model = c.req.header(OWN_KEY_HEADERS.model);
    const built = await providerFromUserKey({
      provider: c.req.header(OWN_KEY_HEADERS.provider) ?? '',
      apiKey,
      ...(model === undefined ? {} : { model }),
    });
    if (!built.ok) return c.json({ error: `your API key: ${built.error}` }, 400);
    await runWithRequestProvider(built.value, () => next());
    return undefined;
  };
}
