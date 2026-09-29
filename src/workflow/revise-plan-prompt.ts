/**
 * Plan revision by prompt: a person reads a generated plan, asks for a
 * change in words ("add a restaurant dashboard"), and the plan is generated
 * again from the original prompt with the change appended.
 *
 * The change is folded into the prompt, not applied to the schema JSON, on
 * purpose: prompt -> ProjectSchema is the one task every planner (Gemini and
 * the local plan adapter alike) is built and measured on. Asking a model to
 * edit a schema would be a new, untested task.
 *
 * Changes accumulate as a list under one heading, so a plan revised three
 * times carries all three requests and the prompt stays readable when a
 * person edits it directly.
 */

export const PLAN_CHANGES_HEADING = 'Changes to the plan:';

export function revisedPlanPrompt(currentPrompt: string, change: string): string {
  const base = currentPrompt.trimEnd();
  const item = `- ${change.trim().replace(/\s+/g, ' ')}`;
  return base.includes(`\n\n${PLAN_CHANGES_HEADING}\n`)
    ? `${base}\n${item}`
    : `${base}\n\n${PLAN_CHANGES_HEADING}\n${item}`;
}
