import { describe, expect, it } from 'vitest';
import { compileConstraintsForDomains, compileDomainConstraints } from './compile-constraints.js';
import { validateProjectSchema } from './validate-project-schema.js';
import {
  DOMAIN_NAMES,
  type DomainName,
  type DomainSpec,
  type ProjectSchema,
  type ValidatedProjectSchema,
} from '../types/project-schema.js';

function emptyDomainSpec(dependsOn: readonly DomainName[] = []): DomainSpec {
  return { components: [], dependsOn };
}

function schemaWithDependsOn(
  dependsOn: Readonly<Record<DomainName, readonly DomainName[]>>,
): ValidatedProjectSchema {
  return asValidated({
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
  });
}

/**
 * The only legitimate way to produce a ValidatedProjectSchema - running a
 * candidate through the real validateProjectSchema, same as any real
 * caller would. Throws on failure rather than returning something
 * type-cast past the brand: a test fixture that fails real validation is
 * a mistake in the fixture, and should fail loudly at the point it was
 * built, not silently downstream where the reason is less obvious.
 */
function asValidated(candidate: ProjectSchema): ValidatedProjectSchema {
  const result = validateProjectSchema(candidate);
  if (!result.ok) {
    throw new Error(`test fixture failed real validateProjectSchema: ${JSON.stringify(result.error)}`);
  }
  return result.value;
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
    const schema: ValidatedProjectSchema = asValidated({
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
    });

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

describe('malformed dependsOn / domain-name inputs (bypass the type system deliberately)', () => {
  it('silently ignores a dependsOn entry naming a domain absent from the domains list', () => {
    // Case 1: Frontend.dependsOn names 'Payments', which is not one of the
    // schema's declared domains. The DomainName type disallows this at
    // compile time - this cast simulates a value that reached the compiler
    // anyway (a validation gap upstream, a hand-built DomainSpec, etc.),
    // which is exactly the trust boundary this test is probing.
    const domains = [...DOMAIN_NAMES];
    const specs: Record<string, DomainSpec> = {
      frontend: { components: [], dependsOn: ['Payments'] as unknown as readonly DomainName[] },
      backend: emptyDomainSpec(),
      database: emptyDomainSpec(),
      security: emptyDomainSpec(),
    };

    const result = compileConstraintsForDomains(domains, (d) => specs[d]!);

    // Actual current behavior: the bogus entry has no effect whatsoever.
    // dependsOn.includes(objectDomain) only ever tests objectDomain values
    // drawn from the real `domains` list, so 'Payments' is never compared
    // against anything and never appears anywhere in the output - not as
    // an error, not as a Constraint, not as a WorkflowPermission. Total
    // record count is unaffected (still the full 12), and frontend->backend
    // is correctly compiled as a prohibition, since the real 'backend'
    // string was never actually present in frontend's dependsOn.
    expect(result.prohibitions.length + result.permissions.length).toBe(TOTAL_ORDERED_PAIRS);
    const mentionsPayments = [...result.prohibitions, ...result.permissions].some((record) =>
      JSON.stringify(record).includes('Payments'),
    );
    expect(mentionsPayments).toBe(false);
    expect(
      result.prohibitions.some((c) => c.subject.phrase === 'frontend' && c.object.phrase === 'backend'),
    ).toBe(true);
  });

  it('silently no-ops a domain naming itself in its own dependsOn', () => {
    // Case 2: frontend lists itself, alongside a real dependency on backend.
    // Uses compileConstraintsForDomains directly, like cases 1 and 3 here -
    // a self-referential dependsOn is exactly what the real
    // validateProjectSchema now rejects (a check added specifically to
    // catch this), so this shape can no longer reach compileDomainConstraints
    // as a ValidatedProjectSchema. The only way to still exercise this path
    // is the same deliberate type-system bypass its siblings already use -
    // no cast needed here specifically, since 'frontend' is a real DomainName
    // value, just an invalid *place* to put it.
    const domains = [...DOMAIN_NAMES];
    const specs: Record<string, DomainSpec> = {
      frontend: { components: [], dependsOn: ['frontend', 'backend'] },
      backend: emptyDomainSpec(),
      database: emptyDomainSpec(),
      security: emptyDomainSpec(),
    };

    const result = compileConstraintsForDomains(domains, (d) => specs[d]!);

    // Actual current behavior, unchanged from before this had to move here:
    // the loop's own `if (subjectDomain === objectDomain) continue;` guard
    // skips every self-pair before dependsOn is ever consulted for it. A
    // self-reference therefore produces neither a permission nor a
    // prohibition for frontend->frontend - that pair is simply never
    // visited, so the self-reference has zero observable effect. Total
    // count is still the full 12 (self-pairs were never part of that count
    // to begin with), and the real frontend->backend permission still
    // compiles correctly.
    expect(result.prohibitions.length + result.permissions.length).toBe(TOTAL_ORDERED_PAIRS);
    const selfPairAsProhibition = result.prohibitions.find(
      (c) => c.subject.phrase === 'frontend' && c.object.phrase === 'frontend',
    );
    const selfPairAsPermission = result.permissions.find(
      (p) => p.subjectDomain === 'frontend' && p.objectDomain === 'frontend',
    );
    expect(selfPairAsProhibition).toBeUndefined();
    expect(selfPairAsPermission).toBeUndefined();
    expect(
      result.permissions.some((p) => p.subjectDomain === 'frontend' && p.objectDomain === 'backend'),
    ).toBe(true);
  });

  it('treats domain names differing only in case as two unrelated domains, not two names for one', () => {
    // Case 3: 'database' and 'Database' both present in the same domains
    // list. The real ProjectSchema.domains object cannot express this (it
    // is a fixed-shape object with exactly the four canonical lowercase
    // keys) - this is tested at the compileConstraintsForDomains level,
    // which accepts an arbitrary domain list and is exactly where a
    // case-variant string could still reach the compiler from a source
    // other than the real ProjectSchema type.
    const domains = ['frontend', 'database', 'Database'] as unknown as readonly DomainName[];
    const specs: Record<string, DomainSpec> = {
      frontend: { components: [], dependsOn: ['database'] as unknown as readonly DomainName[] },
      database: emptyDomainSpec(),
      Database: { components: [], dependsOn: ['frontend'] as unknown as readonly DomainName[] },
    };

    const result = compileConstraintsForDomains(domains, (d) => specs[d]!);

    // Actual current behavior: 3 domains in the list, 3*2 = 6 ordered
    // pairs, all 6 compiled. 'database' and 'Database' are compared with
    // plain JS string equality (Array.prototype.includes), which is
    // case-sensitive, so they are never recognized as the same domain -
    // both survive as fully independent identities, and the pair between
    // them (database->Database and Database->database) is compiled like
    // any other unrelated domain pair rather than being rejected,
    // collapsed, or flagged as a likely duplicate.
    expect(result.prohibitions.length + result.permissions.length).toBe(6);
    const phrasesInvolvingCapitalizedVariant = result.prohibitions
      .filter((c) => c.subject.phrase === 'Database' || c.object.phrase === 'Database')
      .map((c) => `${c.subject.phrase}->${c.object.phrase}`);
    expect(phrasesInvolvingCapitalizedVariant).toEqual(
      expect.arrayContaining(['database->Database', 'Database->database']),
    );
  });
});
