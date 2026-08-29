import { describe, expect, it } from 'vitest';
import { compileConstraintsForDomains, compileDomainConstraints } from './compile-constraints.js';
import { DOMAIN_NAMES, type DomainName, type DomainSpec, type ProjectSchema } from '../types/project-schema.js';

function emptyDomainSpec(dependsOn: readonly DomainName[] = []): DomainSpec {
  return { components: [], dependsOn };
}

function schemaWithDependsOn(dependsOn: Readonly<Record<DomainName, readonly DomainName[]>>): ProjectSchema {
  return {
    sessionId: 'session-test',
    title: 'Test Schema',
    originalPrompt: 'irrelevant for this fixture',
    domains: {
      frontend: emptyDomainSpec(dependsOn.frontend),
      backend: emptyDomainSpec(dependsOn.backend),
      database: emptyDomainSpec(dependsOn.database),
      security: emptyDomainSpec(dependsOn.security),
    },
    constraints: [],
    provenance: 'STATED',
  };
}

// 4 domains, 4*3 = 12 ordered pairs of distinct domains, always.
const TOTAL_ORDERED_PAIRS = DOMAIN_NAMES.length * (DOMAIN_NAMES.length - 1);

describe('compileDomainConstraints', () => {
  it('emits exactly one record per ordered pair of distinct domains, split between prohibitions and permissions', () => {
    const schema = schemaWithDependsOn({
      frontend: ['backend'],
      backend: ['database', 'security'],
      database: [],
      security: [],
    });

    const result = compileDomainConstraints(schema);

    expect(result.prohibitions.length + result.permissions.length).toBe(TOTAL_ORDERED_PAIRS);
    expect(result.permissions).toHaveLength(3); // frontend->backend, backend->database, backend->security
    expect(result.prohibitions).toHaveLength(TOTAL_ORDERED_PAIRS - 3);
  });

  it('a fully-connected schema (every domain depends on every other) emits only permissions', () => {
    const others = (self: DomainName): readonly DomainName[] => DOMAIN_NAMES.filter((d) => d !== self);
    const schema = schemaWithDependsOn({
      frontend: others('frontend'),
      backend: others('backend'),
      database: others('database'),
      security: others('security'),
    });

    const result = compileDomainConstraints(schema);

    expect(result.permissions).toHaveLength(TOTAL_ORDERED_PAIRS);
    expect(result.prohibitions).toHaveLength(0);
  });

  it('a no-dependencies schema emits the full prohibition set, not an empty result', () => {
    const schema = schemaWithDependsOn({ frontend: [], backend: [], database: [], security: [] });

    const result = compileDomainConstraints(schema);

    expect(result.prohibitions).toHaveLength(TOTAL_ORDERED_PAIRS);
    expect(result.permissions).toHaveLength(0);
    for (const prohibition of result.prohibitions) {
      expect(prohibition.relation).toBe('must-not-import');
      expect(prohibition.provenance).toBe('STATED');
      expect(prohibition.source.type).toBe('workflow-edge');
    }
  });

  it('a single-domain-of-interest schema (only frontend has real content) still compiles the full closed-world set', () => {
    // "single-domain" here means only one domain has any components/dependsOn
    // worth naming - all four domain keys still structurally exist, per
    // ProjectSchema's own fixed type, so absence is still not skipped.
    const schema: ProjectSchema = {
      sessionId: 'session-test',
      title: 'Frontend-only prototype',
      originalPrompt: 'irrelevant for this fixture',
      domains: {
        frontend: { components: [{ id: 'x', name: 'Landing Page', purpose: 'The only real content in this schema.' }], dependsOn: [] },
        backend: emptyDomainSpec(),
        database: emptyDomainSpec(),
        security: emptyDomainSpec(),
      },
      constraints: [],
      provenance: 'STATED',
    };

    const result = compileDomainConstraints(schema);

    expect(result.prohibitions).toHaveLength(TOTAL_ORDERED_PAIRS);
    expect(result.permissions).toHaveLength(0);
  });

  it('is deterministic: the same schema compiles to byte-identical output across two runs', () => {
    const schema = schemaWithDependsOn({
      frontend: ['backend'],
      backend: ['database'],
      database: [],
      security: ['database'],
    });

    const first = compileDomainConstraints(schema);
    const second = compileDomainConstraints(schema);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('emits pairs in the documented DOMAIN_NAMES-fixed, subject-major order', () => {
    const schema = schemaWithDependsOn({ frontend: [], backend: [], database: [], security: [] });
    const result = compileDomainConstraints(schema);

    const observedOrder = result.prohibitions.map((c) => [c.subject.phrase, c.object.phrase]);
    const expectedOrder: [DomainName, DomainName][] = [];
    for (const subject of DOMAIN_NAMES) {
      for (const object of DOMAIN_NAMES) {
        if (subject !== object) expectedOrder.push([subject, object]);
      }
    }

    expect(observedOrder).toEqual(expectedOrder);
  });

  it('distinguishes prohibitions from permissions in the returned data', () => {
    const schema = schemaWithDependsOn({ frontend: ['backend'], backend: [], database: [], security: [] });
    const result = compileDomainConstraints(schema);

    // The two arrays are separate types - a permission is never Constraint-shaped.
    expect(Array.isArray(result.prohibitions)).toBe(true);
    expect(Array.isArray(result.permissions)).toBe(true);
    for (const permission of result.permissions) {
      expect(permission).not.toHaveProperty('relation');
      expect(permission).not.toHaveProperty('provenance');
    }
    for (const prohibition of result.prohibitions) {
      expect(prohibition.relation).toBe('must-not-import');
    }
  });

  it('every constraint id is deterministic and unique across the full compiled set', () => {
    const schema = schemaWithDependsOn({ frontend: ['backend'], backend: [], database: [], security: [] });
    const result = compileDomainConstraints(schema);

    const ids = result.prohibitions.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[0-9a-f]{16}$/.test(id))).toBe(true);
  });
});

describe('compileConstraintsForDomains (invariant)', () => {
  it('throws when a non-empty domain list compiles to zero constraints', () => {
    // A single domain has no other distinct domain to pair with - "every
    // ordered pair of distinct domains" is genuinely empty here, and the
    // module treats that as a case to refuse loudly rather than return [].
    expect(() => compileConstraintsForDomains(['frontend'], () => emptyDomainSpec())).toThrow(
      /compiled zero constraints/,
    );
  });

  it('does not throw once a second domain makes at least one pair possible', () => {
    expect(() =>
      compileConstraintsForDomains(['frontend', 'backend'], () => emptyDomainSpec()),
    ).not.toThrow();
  });

  it('does not throw for an empty domain list (vacuously nothing to compile)', () => {
    expect(() => compileConstraintsForDomains([], () => emptyDomainSpec())).not.toThrow();
    expect(compileConstraintsForDomains([], () => emptyDomainSpec())).toEqual({ prohibitions: [], permissions: [] });
  });
});
