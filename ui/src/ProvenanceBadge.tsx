import type { LabelSource } from './api-types';

/**
 * Where a module's name came from.
 *
 * ARCHITECTURAL RULE 2. A user looking at the screen should never have to guess
 * which parts came from static analysis and which from a model. The three
 * states are given different colours, different shapes and different words —
 * not just different shades, so the distinction survives a colour-blind viewer
 * and a greyscale screenshot.
 *
 *   derived   solid green   the deterministic name, traced to file paths
 *   ai        dashed amber  a model wrote this; it may be wrong
 *   yours     solid blue    you wrote this; it outranks both
 */
const STATES: Record<LabelSource, { text: string; title: string }> = {
  mechanical: {
    text: 'derived',
    title: 'Derived from file paths by static analysis. No model involved.',
  },
  llm: {
    text: '~ ai',
    title: 'Written by a language model from this module’s paths and symbols. Not a derived fact — it may be wrong.',
  },
  user: {
    text: '✓ yours',
    title: 'You named this module. It outranks both the derived name and the model’s.',
  },
};

export function ProvenanceBadge({ source }: { source: LabelSource }): JSX.Element {
  const state = STATES[source];
  return (
    <span className="prov" data-source={source} title={state.title}>
      {state.text}
    </span>
  );
}
