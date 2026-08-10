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
/**
 * Supplies the analysis, computed at most once.
 *
 * A function rather than a value because a real host times the handshake.
 * See `serveMcp`.
 */
export type ContextProvider = () => Promise<AnalysisContext>;

export async function handleMessage(
  getContext: ContextProvider,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
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
        /**
         * The analysis is awaited *here*, not at startup.
         *
         * `initialize` and `tools/list` are answered from static data, so the
         * handshake completes in milliseconds however large the repository is.
         * Only a call that actually needs the graph waits for it, and hosts
         * allow far longer for a tool call than for a connection.
         */
        const outcome = callTool(await getContext(), name, asObject(params['arguments']));
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
 *
 * ## Why the context arrives as a promise
 *
 * Found by attaching a real MCP host: the official Inspector gives up on a
 * connection after 15 seconds. The first version analysed the repository and
 * *then* began serving, so on any repository big enough to be interesting the
 * host timed out before the handshake and the server looked broken. A scripted
 * client with no timeout never showed this, which is the whole reason the
 * acceptance criterion asked for a real one.
 *
 * So the loop starts immediately. `initialize`, `ping` and `tools/list` are
 * answered from static data and never touch the analysis; only a tool call
 * awaits it. The caller kicks the pipeline off in parallel, so by the time an
 * agent asks a real question the answer is usually already there.
 *
 * Messages are handled strictly in order. Concurrency would let a fast
 * `tools/list` overtake a slow `tools/call`, and while JSON-RPC permits
 * out-of-order responses, serialising them keeps this server's behaviour
 * reproducible — which is the property the whole project is built on.
 */
export async function serveMcp(getContext: ContextProvider, streams: McpStreams): Promise<void> {
  const lines = createInterface({ input: streams.input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (line.trim() === '') continue;

    const parsed = parseMessage(line);
    if (isFailure(parsed)) {
      streams.write(JSON.stringify(parsed));
      continue;
    }

    const response = await handleMessage(getContext, parsed);
    if (response !== null) streams.write(JSON.stringify(response));
  }
}
