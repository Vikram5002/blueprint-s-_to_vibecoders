import { describe, expect, it } from 'vitest';
import { completeDomainDependencies } from './complete-dependencies.js';
import type { DomainName } from '../types/project-schema.js';

function plan(backend: number, database: number, backendDependsOn: DomainName[] = []) {
  const domain = (n: number, dependsOn: DomainName[] = []) => ({ components: Array.from({ length: n }, (_, i) => ({ id: `c${i}` })), dependsOn });
  return { title: 'p', domains: { frontend: domain(2, ['backend']), backend: domain(backend, backendDependsOn), database: domain(database), security: domain(0) } };
}

describe('completeDomainDependencies', () => {
  it('links the API to the database when the plan has both but forgot the link', () => {
    const fixed = completeDomainDependencies(plan(2, 3));
    expect(fixed.domains.backend.dependsOn).toEqual(['database']);
    expect(fixed.domains.frontend.dependsOn).toEqual(['backend']);
  });

  it('keeps an existing link and the rest of the dependsOn list as they were', () => {
    const original = plan(1, 1, ['security', 'database']);
    expect(completeDomainDependencies(original)).toBe(original);
  });

  it('adds nothing when either side is empty', () => {
    expect(completeDomainDependencies(plan(0, 2)).domains.backend.dependsOn).toEqual([]);
    expect(completeDomainDependencies(plan(2, 0)).domains.backend.dependsOn).toEqual([]);
  });

  it('never lets pages import the backend: only backend -> database is ever added', () => {
    const fixed = completeDomainDependencies(plan(1, 1));
    expect(fixed.domains.frontend.dependsOn).not.toContain('database');
    expect(fixed.domains.security.dependsOn).toEqual([]);
  });
});
