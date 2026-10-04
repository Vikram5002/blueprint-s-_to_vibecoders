/**
 * What every API request carries besides its own data (see src/server/hosted.ts):
 *
 * - this browser's id (x-vibe-owner): a random value made once and kept here,
 *   so a hosted server shows this browser only its own projects;
 * - the access code of a hosted server (x-vibe-access), once typed in;
 * - the person's own model key (x-vibe-provider / x-vibe-api-key /
 *   x-vibe-model), when they chose to use one.
 *
 * All three live in this browser's localStorage and nowhere else; the server
 * uses them per request and stores none of them. A local server ignores the
 * id and the code, and honours the key the same way.
 */

export const OWN_KEY_PROVIDERS = [
  { id: 'groq', label: 'Groq (free)', keyUrl: 'https://console.groq.com/keys' },
  { id: 'gemini', label: 'Google Gemini (free)', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'openrouter', label: 'OpenRouter (free models)', keyUrl: 'https://openrouter.ai/keys' },
  {
    id: 'github',
    label: 'GitHub Models (free)',
    keyUrl: 'https://github.com/settings/personal-access-tokens',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (paid)',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
] as const;

export type OwnKeyProvider = (typeof OWN_KEY_PROVIDERS)[number]['id'];

export interface OwnKey {
  readonly provider: OwnKeyProvider;
  readonly apiKey: string;
  readonly model?: string;
}

const OWNER_KEY = 'vibe.owner';
const ACCESS_KEY = 'vibe.accessCode';
const OWN_KEY = 'vibe.ownKey';
export const OWN_KEY_CHANGED = 'vibe:own-key-changed';
export const NEEDS_ACCESS_CODE = 'vibe:needs-access-code';

function read(name: string): string | null {
  try {
    return window.localStorage.getItem(name);
  } catch {
    return null;
  }
}

function write(name: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(name);
    else window.localStorage.setItem(name, value);
  } catch {
    // Storage blocked (private window): the value lasts for this page only.
  }
}

let memoryOwner: string | null = null;

export function browserId(): string {
  const stored = read(OWNER_KEY);
  if (stored !== null && /^[A-Za-z0-9_-]{16,64}$/.test(stored)) return stored;
  if (memoryOwner === null) {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    memoryOwner = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    write(OWNER_KEY, memoryOwner);
  }
  return memoryOwner;
}

export function accessCode(): string | null {
  return read(ACCESS_KEY);
}

export function setAccessCode(code: string | null): void {
  write(ACCESS_KEY, code);
}

export function ownKey(): OwnKey | null {
  const raw = read(OWN_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OwnKey>;
    const known = OWN_KEY_PROVIDERS.some((entry) => entry.id === parsed.provider);
    if (!known || typeof parsed.apiKey !== 'string' || parsed.apiKey === '') return null;
    return {
      provider: parsed.provider as OwnKeyProvider,
      apiKey: parsed.apiKey,
      ...(typeof parsed.model === 'string' && parsed.model !== '' ? { model: parsed.model } : {}),
    };
  } catch {
    return null;
  }
}

export function setOwnKey(key: OwnKey | null): void {
  write(OWN_KEY, key === null ? null : JSON.stringify(key));
  window.dispatchEvent(new Event(OWN_KEY_CHANGED));
}

/** The headers above, for one request to this app's own /api. */
export function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'x-vibe-owner': browserId() };
  const code = accessCode();
  if (code !== null) headers['x-vibe-access'] = code;
  const key = ownKey();
  if (key !== null) {
    headers['x-vibe-provider'] = key.provider;
    headers['x-vibe-api-key'] = key.apiKey;
    if (key.model !== undefined) headers['x-vibe-model'] = key.model;
  }
  return headers;
}

function isOwnApi(input: RequestInfo | URL): boolean {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, window.location.href);
  return url.origin === window.location.origin && url.pathname.startsWith('/api/');
}

let installed = false;

/**
 * Adds the headers to every request this page makes to its own /api, so no
 * component has to remember to. Called once, before the app renders.
 */
export function installApiHeaders(): void {
  if (installed) return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isOwnApi(input)) return original(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    for (const [name, value] of Object.entries(apiHeaders()))
      if (!headers.has(name)) headers.set(name, value);
    const response = await original(input, { ...init, headers });
    if (response.status === 401) {
      const body = (await response
        .clone()
        .json()
        .catch(() => null)) as { needsAccessCode?: boolean } | null;
      if (body?.needsAccessCode === true) window.dispatchEvent(new Event(NEEDS_ACCESS_CODE));
    }
    return response;
  };
}

export interface HostedInfo {
  readonly hosted: true;
  readonly accessOk: boolean;
  readonly dailyRuns: number;
  readonly usedToday: number | null;
  readonly monthlyLeft: number | null;
}

/** Null on a local server (which has no /api/hosted). */
export async function fetchHostedInfo(): Promise<HostedInfo | null> {
  try {
    const response = await fetch('/api/hosted');
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<HostedInfo>;
    return body.hosted === true ? (body as HostedInfo) : null;
  } catch {
    return null;
  }
}
