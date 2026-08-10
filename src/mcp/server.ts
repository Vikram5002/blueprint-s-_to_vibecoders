/**
 * The MCP server loop: read a line, dispatch it, write one line back.
 *
 * Deliberately transport-agnostic at the core. `handleMessage` is a pure
 * function from a request to a response, so the whole protocol can be tested
 * without spawning a process or touching a stream — and `serveMcp` is the thin
 * shell that wires it to stdin and stdout.
 */
import { createInterface } from 'node:readline';
import { callTool, TOOL_DEFINITIONS } from './tools.js';
import {
  ERROR_INVALID_PARAMS,
  ERROR_METHOD_NOT_FOUND,
  failure,
  initializeResult,
  isFailure,
  isNotification,
  parseMessage,
  success,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './protocol.js';
import type { AnalysisContext } from '../server/context.js';

/**
 * Answers one request, or returns null for a notification.
 *
 * Null rather than an empty response because JSON-RPC 2.0 §4.1 says a
 * notification must not be replied to at all. Sending `{"result": null}` back
 * for `notifications/initialized` makes stricter clients report a protocol
 * error, and it is the single easiest thing to get wrong in a hand-rolled
 * implementation.
 */
export function handleMessage(
  context: AnalysisContext,
  request: JsonRpcRequest,
): JsonRpcResponse | null {
  if (isNotification(request)) return null;
  const id = request.id ?? null;

  switch (request.method) {
    case 'initialize': {
      const params = asObject(request.params);
      return success(id, initializeResult(params['protocolVersion']));
    }

    /** Liveness check. Answers an empty object, per the spec. */
    case 'ping':
      return success(id, {});

    case 'tools/list':
      return success(id, { tools: TOOL_DEFINITIONS });

    case 'tools/call': {
      const params = asObject(request.params);
      const name = params['name'];
      if (typeof name !== 'string') {
        return failure(id, ERROR_INVALID_PARAMS, 'tools/call requires a string "name"');
      }

      /**
       * A tool that throws returns an *error result*, not a JSON-RPC error.
       * The distinction matters to an agent: a protocol error is "the server
       * is broken and you should stop", while an error result is "that call
       * did not work, consider trying something else". Reporting a bad path
       * as a transport failure would make a recoverable mistake look fatal.
       */
      try {
        const outcome = callTool(context, name, asObject(params['arguments']));
        return success(id, { content: outcome.content, isError: outcome.isError });
      } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return success(id, {
          content: [{ type: 'text', text: `${name} failed: ${message}` }],
          isError: true,
        });
      }
    }

    default:
      return failure(id, ERROR_METHOD_NOT_FOUND, `unknown method "${request.method}"`);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface McpStreams {
  readonly input: NodeJS.ReadableStream;
  readonly write: (line: string) => void;
}

/**
 * Runs until stdin closes, which is how an MCP client says goodbye.
 *
 * One JSON object per line, both directions. Nothing else may ever be written
 * to this stream — a stray log line is indistinguishable from a malformed
 * message to the client.
 */
export async function serveMcp(context: AnalysisContext, streams: McpStreams): Promise<void> {
  const lines = createInterface({ input: streams.input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (line.trim() === '') continue;

    const parsed = parseMessage(line);
    if (isFailure(parsed)) {
      streams.write(JSON.stringify(parsed));
      continue;
    }

    const response = handleMessage(context, parsed);
    if (response !== null) streams.write(JSON.stringify(response));
  }
}
