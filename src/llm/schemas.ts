/**
 * Output schemas the model is held to.
 *
 * These live here rather than in a vendor adapter because they are part of the
 * *request*, not part of any provider. They were originally defined in
 * `anthropic.ts`, which was fine while there was one vendor and actively
 * misleading once there were two: `label-modules.ts` imported a schema from a
 * file named after a vendor, and the Anthropic adapter quietly substituted it
 * whenever a caller left `schema` unset.
 *
 * That default hid a real bug. The labeller never passed a schema at all, and
 * nothing failed, because Anthropic filled one in. Pointing the same code at
 * Gemini produced free-form JSON with a `name` field where the validator wanted
 * `label`, and every module in the run was rejected — the first request to a
 * second provider was the first time anyone learned the schema was not
 * actually being sent.
 *
 * So the schema is passed explicitly by every call site and no adapter supplies
 * a fallback. An interface that only works because one implementation guesses
 * on your behalf is not provider-agnostic.
 */

/** A cluster's name and one-line description. */
export const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string', description: 'Two to four words, title case.' },
    description: { type: 'string', description: 'One line on what the module does.' },
  },
  required: ['label', 'description'],
  additionalProperties: false,
} as const;
