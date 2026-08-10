/**
 * JSON-RPC 2.0 over stdio, which is what MCP is on the wire.
 *
 * ## Why this is hand-rolled
 *
 * CLAUDE.md says not to install heavy dependencies without asking, and this
 * project has taken that seriously before: there is no `@google/genai`, and
 * `.env` is read by fifteen lines rather than dotenv. The MCP surface a
 * read-only server needs is four methods and one framing rule, and the
 * official SDK brings a transport abstraction, a session layer and a schema
 * validator to hold them. That is a poor trade for a CLI whose startup time is
 * a stated design constraint.
 *
 * The cost of this choice is that protocol correctness is now *our* problem,
 * so it is demonstrated rather than asserted: `protocol.test.ts` drives the
 * real handshake, and Week 11's acceptance connects an actual MCP client and
 * records the exchange.
 *
 * ## Framing
 *
 * Newline-delimited JSON on stdin and stdout, one message per line. Nothing is
 * ever written to stdout that is not a JSON-RPC message — a stray `console.log`
 * corrupts the stream and the client sees a parse error rather than a log line.
 * Diagnostics go to stderr, which the client ignores.
 *
 * ## This is not a network server (rule 6)
 *
 * stdio is a pipe to a parent process that already has our file descriptors.
 * Nothing binds, nothing listens, and no port is opened — so the local-only
 * property of the HTTP server is not merely matched here, it is stronger.
 * `architecture.test.ts` checks that this directory opens no sockets.
 */

/**
 * The protocol revisions this server knows how to speak.
 *
 * Ordered newest first. A client names its preferred version in `initialize`;
 * if we know it, we echo it back, and otherwise we answer with our newest and
 * let the client decide whether it can proceed. Echoing back an unknown version
 * would be a lie, and picking silently without saying so is how two peers end
 * up disagreeing about the shape of a message three calls later.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export const SERVER_INFO = { name: 'vibe-blueprint', version: '0.1.0' } as const;

export const JSON_RPC_VERSION = '2.0';

/** Standard JSON-RPC error codes. */
export const ERROR_PARSE = -32700;
export const ERROR_INVALID_REQUEST = -32600;
export const ERROR_METHOD_NOT_FOUND = -32601;
export const ERROR_INVALID_PARAMS = -32602;
export const ERROR_INTERNAL = -32603;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  /** Absent on a notification, which must not be answered. */
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

export function failure(id: JsonRpcId, code: number, message: string): JsonRpcFailure {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}

/**
 * Parses one line into a request.
 *
 * Returns a failure response rather than throwing: a malformed line from a
 * client must not take the server down, because the client is then stuck
 * waiting for a reply that will never come.
 */
export function parseMessage(line: string): JsonRpcRequest | JsonRpcFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return failure(null, ERROR_PARSE, 'message was not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return failure(null, ERROR_INVALID_REQUEST, 'message was not a JSON-RPC object');
  }

  const message = parsed as Record<string, unknown>;
  if (message['jsonrpc'] !== JSON_RPC_VERSION) {
    return failure(idOf(message), ERROR_INVALID_REQUEST, 'jsonrpc must be exactly "2.0"');
  }
  if (typeof message['method'] !== 'string') {
    return failure(idOf(message), ERROR_INVALID_REQUEST, 'method must be a string');
  }

  const request: JsonRpcRequest = {
    jsonrpc: JSON_RPC_VERSION,
    method: message['method'],
    ...('id' in message ? { id: idOf(message) } : {}),
    ...('params' in message ? { params: message['params'] } : {}),
  };
  return request;
}

function idOf(message: Record<string, unknown>): JsonRpcId {
  const id = message['id'];
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

export function isFailure(value: JsonRpcRequest | JsonRpcFailure): value is JsonRpcFailure {
  return 'error' in value;
}

/** A notification carries no id and must never be answered (JSON-RPC 2.0 §4.1). */
export function isNotification(request: JsonRpcRequest): boolean {
  return request.id === undefined;
}

export function negotiateVersion(requested: unknown): string {
  const newest = SUPPORTED_PROTOCOL_VERSIONS[0];
  if (typeof requested !== 'string') return newest;
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : newest;
}

/**
 * The `initialize` result.
 *
 * `tools` is the only capability declared, and it is declared without
 * `listChanged`: the analysis is computed once per process and the tool list
 * cannot change while we are running, so advertising the notification would
 * promise a message we would never send.
 *
 * No `resources`, no `prompts`, and above all no capability that implies
 * writing. The scope note for this week says read-only, and the honest place
 * to enforce that is here, where a client discovers what we will do.
 */
export function initializeResult(requested: unknown): unknown {
  return {
    protocolVersion: negotiateVersion(requested),
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions:
      'Read-only architecture context for this repository. Every response is labelled ' +
      'DERIVED (traced to a real import statement), STATED (claimed in prose), or ' +
      'COMPARISON (the two measured against each other). Call check_import before ' +
      'writing an import to find out whether the repository’s own documented rules allow it.',
  };
}
