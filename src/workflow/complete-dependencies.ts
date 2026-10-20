/**
 * The one domain link a full-stack plan cannot do without.
 *
 * A plan's dependsOn arrays compile into closed-world rules (compile-
 * constraints.ts): a link a model forgets becomes a prohibition. A plan with
 * API components and database tables but no backend -> database link
 * therefore forbids every route from reading a table, and the generator,
 * obeying it, fakes the data in memory. Found live (2026-10-20): 271 of 283
 * teacher plans left the link out, and all 375 route files built from them
 * kept their records in arrays.
 *
 * Deterministic and minimal: the link is added only when both domains have
 * components. Pages still may not import the backend - they reach it over
 * HTTP - so nothing else is added.
 */
import type { DomainName } from '../types/project-schema.js';

interface PlanShape {
  readonly domains: Readonly<Record<DomainName, { readonly components: readonly unknown[]; readonly dependsOn: readonly DomainName[] }>>;
}

/** The plan with backend -> database added when the plan has both and does not say so already. */
export function completeDomainDependencies<T extends PlanShape>(plan: T): T {
  const { backend, database } = plan.domains;
  if (backend.components.length === 0 || database.components.length === 0 || backend.dependsOn.includes('database')) return plan;
  return { ...plan, domains: { ...plan.domains, backend: { ...backend, dependsOn: [...backend.dependsOn, 'database'] } } };
}
