/**
 * Validation of model-supplied labels.
 *
 * This is the defence that actually holds against prompt injection. The system
 * prompt asks the model to treat repository content as data; this module does
 * not depend on it having worked. A label is a short human-readable string and
 * nothing else, so anything that does not look like one is rejected and the
 * module keeps its mechanical name.
 *
 * Rejection is cheap here — labels are cosmetic and there is always a
 * deterministic fallback — so the checks are deliberately strict. Week 7 reads
 * intent from prose, where the same posture will matter far more.
 */

export const MAX_LABEL_LENGTH = 48;
export const MAX_DESCRIPTION_LENGTH = 160;

export interface CandidateLabel {
  readonly label: string;
  readonly description: string | null;
}

export type LabelRejection =
  | 'not-an-object'
  | 'missing-label'
  | 'empty'
  | 'too-long'
  | 'control-characters'
  | 'markup'
  | 'looks-like-instructions';

export type LabelValidation =
  | { readonly ok: true; readonly value: CandidateLabel }
  | { readonly ok: false; readonly reason: LabelRejection };

/**
 * Phrases that have no business in a module name. A model that has been talked
 * into repeating injected text usually reproduces this vocabulary, and a
 * genuine label never does.
 */
const INSTRUCTION_MARKERS = [
  'ignore previous',
  'ignore all previous',
  'disregard',
  'system prompt',
  'you are now',
  'new instructions',
  'instead of naming',
  'http://',
  'https://',
];

export function validateLabel(candidate: unknown): LabelValidation {
  if (typeof candidate !== 'object' || candidate === null) {
    return { ok: false, reason: 'not-an-object' };
  }

  const record = candidate as Record<string, unknown>;
  if (typeof record['label'] !== 'string') {
    return { ok: false, reason: 'missing-label' };
  }

  const label = record['label'].replace(/\s+/g, ' ').trim();
  const rawDescription = typeof record['description'] === 'string' ? record['description'] : '';
  const description = rawDescription.replace(/\s+/g, ' ').trim();

  if (label === '') {
    return { ok: false, reason: 'empty' };
  }
  if (label.length > MAX_LABEL_LENGTH || description.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }

  const combined = `${label} ${description}`;
  // Code points rather than a regex literal: embedding control characters in
  // source makes the file binary to git and grep.
  const hasControlCharacter = [...combined].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  if (hasControlCharacter) {
    return { ok: false, reason: 'control-characters' };
  }
  if (/[<>{}]|\]\(|`{3}/.test(combined)) {
    return { ok: false, reason: 'markup' };
  }

  const lowered = combined.toLowerCase();
  if (INSTRUCTION_MARKERS.some((marker) => lowered.includes(marker))) {
    return { ok: false, reason: 'looks-like-instructions' };
  }

  return { ok: true, value: { label, description: description === '' ? null : description } };
}

/**
 * Parses a model response into a candidate label.
 *
 * Structured outputs make the response a JSON object, but the parse is defended
 * anyway: a provider that returns something else, or a future provider without
 * schema support, must fail closed rather than throw.
 */
export function parseLabelResponse(text: string): LabelValidation {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return { ok: false, reason: 'not-an-object' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return { ok: false, reason: 'not-an-object' };
  }

  return validateLabel(parsed);
}
