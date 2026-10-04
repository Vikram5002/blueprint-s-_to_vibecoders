/**
 * The extension's only way to the analysis: the server's JSON API. No
 * business logic here - the server decides which rules a file breaks and
 * checks the proposal; this file only carries requests and answers.
 */

export interface FileViolation {
  readonly ruleText: string;
  readonly explanation: string;
  readonly evidence: readonly { readonly line: number; readonly snippet: string }[];
}

export interface ReworkCheck {
  readonly ruleText: string;
  readonly line: number;
  readonly snippet: string;
  readonly lookedFor: string;
  readonly stillPresent: boolean;
}

export interface ReworkAnswer {
  readonly path: string;
  readonly violations: readonly FileViolation[];
  readonly proposed: string;
  readonly checks: readonly ReworkCheck[];
  readonly unchanged: boolean;
}

export interface ApiOptions {
  readonly baseUrl: string;
  /** Hosted mode's access code; sent on every request when set. */
  readonly accessCode?: string;
  readonly fetchImpl?: typeof fetch;
}

/** Long enough for a slow free-tier model; short enough to not hang forever. */
const REWORK_TIMEOUT_MS = 5 * 60_000;

export class ApiClient {
  private readonly baseUrl: string;
  private readonly accessCode: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.accessCode = options.accessCode?.trim() ?? '';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async violations(path: string): Promise<readonly FileViolation[]> {
    const body = (await this.call(`/api/rework/violations?path=${encodeURIComponent(path)}`, { method: 'GET' })) as {
      violations: FileViolation[];
    };
    return body.violations;
  }

  async rework(request: { path: string; source: string; instruction?: string }): Promise<ReworkAnswer> {
    return (await this.call('/api/rework', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REWORK_TIMEOUT_MS),
    })) as ReworkAnswer;
  }

  private async call(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (this.accessCode !== '') headers.set('x-vibe-access', this.accessCode);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (cause) {
      throw new Error(`the VibeCoder server at ${this.baseUrl} did not answer (${describe(cause)})`);
    }
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON - keep the text for the error message
    }
    if (!response.ok) {
      const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return body;
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.name === 'TimeoutError' ? 'timed out' : cause.message;
  return String(cause);
}
