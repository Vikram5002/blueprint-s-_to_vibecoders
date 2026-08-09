/**
 * Chat transcripts as an intent source.
 *
 * ## One format, properly
 *
 * Supported: **Claude Code session transcripts** — JSON Lines, one object per
 * line, as written to `~/.claude/projects/<slug>/<session>.jsonl`.
 *
 * Chat-log formats differ per agent and none of them is stable. Supporting three
 * badly means three half-tested parsers that each silently drop messages, and a
 * silently dropped message is invisible in every metric downstream: recall falls
 * and nothing says why. One format that is parsed correctly, and an explicit
 * refusal for everything else, is the honest version. `detectFormat` names what
 * it found so an unsupported transcript is reported rather than ignored.
 *
 * ## Only human turns are read
 *
 * A transcript contains the user's messages and the agent's. Only the user's are
 * treated as statements of intent, and this is the single most important
 * decision in this file.
 *
 * The agent's turns are full of architectural-sounding prose — it explains
 * designs, restates rules, proposes structures. Extracting from them would let
 * the tool read its own output back as though it were the developer's intent,
 * and then measure the codebase against it. That is not measurement, it is a
 * mirror: an agent that built the wrong thing and described it confidently would
 * produce constraints its own work satisfies perfectly.
 *
 * The whole premise of this project is comparing what a developer *said* against
 * what their agent *built*. Reading the agent's side of the conversation as
 * "said" collapses the two things being compared into one.
 */
import type { IntentDocument } from './sources.js';

export type ChatFormat = 'claude-code-jsonl' | 'unknown';

export interface ChatParseResult {
  readonly format: ChatFormat;
  readonly documents: readonly IntentDocument[];
  /** Lines that were not valid JSON. Reported, never fatal. */
  readonly malformedLines: number;
  /** Human turns found, before length filtering. */
  readonly humanTurns: number;
  /** Turns skipped because they came from the agent. */
  readonly agentTurns: number;
}

/** Below this a message is a "yes", "go on", or a paste of a path. */
const MIN_MESSAGE_CHARS = 40;

/**
 * Wrappers the harness injects into the user turn that the user did not write.
 *
 * Found by running this parser over a real transcript rather than a synthetic
 * one: six of seven human turns in the sample were dominated by
 * `<ide_opened_file>` and `<local-command-caveat>` blocks. These arrive inside
 * `type: "user"` messages, so the role check does not catch them.
 *
 * This is the same failure as reading the agent's turns back — tool-generated
 * text entering the STATED side of the model — just wearing a different label.
 * A constraint sourced from `<system-reminder>` would be the tool measuring the
 * harness that runs it.
 */
const HARNESS_WRAPPERS = [
  'system-reminder',
  'ide_opened_file',
  'ide_selection',
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'command-name',
  'command-message',
  'command-args',
  'user-prompt-submit-hook',
];

const WRAPPER_PATTERN = new RegExp(
  `<(${HARNESS_WRAPPERS.join('|')})>[\\s\\S]*?</\\1>|<(${HARNESS_WRAPPERS.join('|')})>[\\s\\S]*$`,
  'g',
);

/** Removes harness wrappers, leaving only what the developer typed. */
export function stripHarnessWrappers(text: string): string {
  return text.replace(WRAPPER_PATTERN, '').trim();
}

interface TranscriptLine {
  readonly type?: unknown;
  readonly uuid?: unknown;
  readonly timestamp?: unknown;
  readonly isSidechain?: unknown;
  readonly message?: { readonly role?: unknown; readonly content?: unknown };
}

/**
 * Identifies the transcript format from its first lines.
 *
 * Cheap and total: anything not recognised is `unknown`, and the caller reports
 * that rather than attempting a best-effort parse.
 */
export function detectFormat(raw: string): ChatFormat {
  for (const line of raw.split(/\r?\n/).slice(0, 40)) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as TranscriptLine;
    // The distinguishing pair: a per-line `type` alongside a `message` envelope.
    if (typeof record.type === 'string' && ['user', 'assistant'].includes(record.type)) {
      return 'claude-code-jsonl';
    }
  }
  return 'unknown';
}

export function parseChatLog(raw: string, location: string): ChatParseResult {
  const format = detectFormat(raw);
  if (format !== 'claude-code-jsonl') {
    return { format, documents: [], malformedLines: 0, humanTurns: 0, agentTurns: 0 };
  }

  const documents: IntentDocument[] = [];
  let malformedLines = 0;
  let humanTurns = 0;
  let agentTurns = 0;

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as TranscriptLine;

    if (record.type === 'assistant') {
      agentTurns += 1;
      continue;
    }
    if (record.type !== 'user') continue;
    // Sidechain turns are subagent traffic, not the developer talking.
    if (record.isSidechain === true) continue;

    const raw = extractText(record.message?.content);
    if (raw === null) continue;
    humanTurns += 1;

    // Tool results arrive as `user` turns. They are file contents and command
    // output — not the developer's intent, and the largest source of noise here.
    if (isToolResult(record.message?.content)) continue;

    const text = stripHarnessWrappers(raw);
    if (text.length < MIN_MESSAGE_CHARS) continue;

    documents.push({
      type: 'chat-log',
      location: `${location}#${typeof record.uuid === 'string' ? record.uuid : String(documents.length)}`,
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
      text,
      truncated: false,
    });
  }

  return { format, documents, malformedLines, humanTurns, agentTurns };
}

function isToolResult(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'tool_result',
  );
}

/** Content is either a plain string or an array of typed blocks. */
function extractText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.trim() === '' ? null : content;
  }
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') {
      parts.push(typed.text);
    }
  }
  const joined = parts.join('\n').trim();
  return joined === '' ? null : joined;
}
