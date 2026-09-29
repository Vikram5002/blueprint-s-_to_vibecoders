import { describe, expect, it } from 'vitest';
import { PLAN_CHANGES_HEADING, revisedPlanPrompt } from './revise-plan-prompt.js';

describe('revisedPlanPrompt', () => {
  it('appends the first change under a heading, keeping the original prompt first', () => {
    expect(revisedPlanPrompt('A food delivery site.', 'add a restaurant dashboard')).toBe(
      `A food delivery site.\n\n${PLAN_CHANGES_HEADING}\n- add a restaurant dashboard`,
    );
  });

  it('adds later changes to the same list instead of a second heading', () => {
    const once = revisedPlanPrompt('A food delivery site.', 'add a restaurant dashboard');
    const twice = revisedPlanPrompt(once, 'drop the admin page');
    expect(twice).toBe(
      `A food delivery site.\n\n${PLAN_CHANGES_HEADING}\n- add a restaurant dashboard\n- drop the admin page`,
    );
    expect(twice.split(PLAN_CHANGES_HEADING)).toHaveLength(2);
  });

  it('flattens a multi-line change into one list item', () => {
    expect(revisedPlanPrompt('App.  ', '  add login\n  with Google  ')).toBe(
      `App.\n\n${PLAN_CHANGES_HEADING}\n- add login with Google`,
    );
  });
});
