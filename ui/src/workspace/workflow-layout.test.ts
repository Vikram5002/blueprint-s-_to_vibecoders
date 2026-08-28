import { describe, expect, it } from 'vitest';
import {
  computeLayout,
  deriveEdges,
  exceedsDirectListLimit,
  paginateComponents,
  DIRECT_LIST_LIMIT,
  COMPONENTS_PER_PAGE,
} from './workflow-layout';
import { SMALL_PROJECT_SCHEMA, LARGE_PROJECT_SCHEMA } from './workflow-mocks';
import type { ProjectSchema } from './project-schema-types';

/**
 * The layout's one hard requirement: identical input always produces
 * identical positions. No physics, no randomness, no dependence on object
 * identity or insertion order — these tests construct the "same" schema
 * twice, as genuinely separate objects, and check the positions are
 * `toEqual` (deep value equality), not merely computed from the same
 * reference.
 */
describe('computeLayout: determinism', () => {
  it('produces identical positions for two separately-constructed, value-equal schemas', () => {
    const schemaA: ProjectSchema = JSON.parse(
      JSON.stringify(SMALL_PROJECT_SCHEMA),
    ) as ProjectSchema;
    const schemaB: ProjectSchema = JSON.parse(
      JSON.stringify(SMALL_PROJECT_SCHEMA),
    ) as ProjectSchema;

    expect(schemaA).not.toBe(schemaB); // genuinely different objects
    expect(computeLayout(schemaA)).toEqual(computeLayout(schemaB));
  });

  it('produces identical positions across repeated calls on the same schema', () => {
    const first = computeLayout(SMALL_PROJECT_SCHEMA);
    const second = computeLayout(SMALL_PROJECT_SCHEMA);
    const third = computeLayout(SMALL_PROJECT_SCHEMA);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it('places every one of the four fixed domains, regardless of schema content', () => {
    const layout = computeLayout(SMALL_PROJECT_SCHEMA);
    expect(Object.keys(layout).sort()).toEqual(['backend', 'database', 'frontend', 'security']);
    for (const position of Object.values(layout)) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
    }
  });

  it('places a domain with dependencies strictly above (numerically less y, if drawn bottom-up) the domains it depends on', () => {
    // frontend depends on backend depends on {database, security} (leaves).
    // Layer 0 (leaves) is drawn at the largest y (bottom); higher layers at
    // smaller y (top) — see computeLayout's y formula.
    const layout = computeLayout(SMALL_PROJECT_SCHEMA);
    expect(layout.frontend.y).toBeLessThan(layout.backend.y);
    expect(layout.backend.y).toBeLessThan(layout.database.y);
    expect(layout.backend.y).toBeLessThan(layout.security.y);
  });

  it('handles a domain with no dependencies and no dependents without crashing', () => {
    const isolated: ProjectSchema = {
      ...SMALL_PROJECT_SCHEMA,
      domains: {
        ...SMALL_PROJECT_SCHEMA.domains,
        security: { components: [], dependsOn: [] },
      },
    };
    expect(() => computeLayout(isolated)).not.toThrow();
  });

  it('never infinite-loops on a schema describing a circular dependency', () => {
    const cyclic: ProjectSchema = {
      ...SMALL_PROJECT_SCHEMA,
      domains: {
        frontend: { components: [], dependsOn: ['backend'] },
        backend: { components: [], dependsOn: ['frontend'] }, // cycle
        database: { components: [], dependsOn: [] },
        security: { components: [], dependsOn: [] },
      },
    };
    expect(() => computeLayout(cyclic)).not.toThrow();
    // Still deterministic even though the input is a degenerate cycle.
    expect(computeLayout(cyclic)).toEqual(computeLayout(cyclic));
  });
});

describe('deriveEdges', () => {
  it('produces one edge per dependsOn declaration', () => {
    const edges = deriveEdges(SMALL_PROJECT_SCHEMA);
    const pairs = edges.map((e) => `${e.from}->${e.to}`).sort();
    expect(pairs).toEqual(['backend->database', 'backend->security', 'frontend->backend']);
  });

  it('attaches the matching constraint to the edge it describes', () => {
    const edges = deriveEdges(SMALL_PROJECT_SCHEMA);
    const backendToDatabase = edges.find((e) => e.from === 'backend' && e.to === 'database');
    expect(backendToDatabase?.constraint?.rawText).toBe(
      'The backend sits above the database; the database must never import the backend.',
    );
  });

  it('matches a constraint regardless of which domain is phrased as subject vs object', () => {
    // The mock constraint for backend<->security is phrased subject=security,
    // object=backend — the reverse of the edge direction (backend depends on
    // security) — and must still attach.
    const edges = deriveEdges(SMALL_PROJECT_SCHEMA);
    const backendToSecurity = edges.find((e) => e.from === 'backend' && e.to === 'security');
    expect(backendToSecurity?.constraint).not.toBeNull();
  });

  it('leaves an edge with no stated rule as null, never a fabricated constraint', () => {
    const edges = deriveEdges(SMALL_PROJECT_SCHEMA);
    const frontendToBackend = edges.find((e) => e.from === 'frontend' && e.to === 'backend');
    expect(frontendToBackend?.constraint).toBeNull();
  });

  it("weighs an edge by its dependent domain's component count", () => {
    const edges = deriveEdges(SMALL_PROJECT_SCHEMA);
    const frontendToBackend = edges.find((e) => e.from === 'frontend' && e.to === 'backend');
    expect(frontendToBackend?.weight).toBe(SMALL_PROJECT_SCHEMA.domains.frontend.components.length);
  });

  it('produces no edges for a schema with no dependencies at all', () => {
    const noDeps: ProjectSchema = {
      ...SMALL_PROJECT_SCHEMA,
      domains: {
        frontend: { components: [], dependsOn: [] },
        backend: { components: [], dependsOn: [] },
        database: { components: [], dependsOn: [] },
        security: { components: [], dependsOn: [] },
      },
    };
    expect(deriveEdges(noDeps)).toEqual([]);
  });
});

describe('scale guard: the large mock schema is not skipped', () => {
  it('LARGE_PROJECT_SCHEMA really does exceed the direct-list limit', () => {
    expect(LARGE_PROJECT_SCHEMA.domains.backend.components.length).toBeGreaterThan(
      DIRECT_LIST_LIMIT,
    );
    expect(exceedsDirectListLimit(LARGE_PROJECT_SCHEMA.domains.backend)).toBe(true);
  });

  it('a domain at or under the limit is not flagged', () => {
    expect(exceedsDirectListLimit(SMALL_PROJECT_SCHEMA.domains.frontend)).toBe(false);
  });

  it('layout still computes for the oversized schema — only 4 graph nodes ever exist, never one per component', () => {
    const layout = computeLayout(LARGE_PROJECT_SCHEMA);
    expect(Object.keys(layout)).toHaveLength(4);
  });

  it('paginates the oversized domain into fixed-size pages covering every component exactly once', () => {
    const domain = LARGE_PROJECT_SCHEMA.domains.backend;
    const firstPage = paginateComponents(domain, 1);
    expect(firstPage.items).toHaveLength(COMPONENTS_PER_PAGE);
    expect(firstPage.totalComponents).toBe(domain.components.length);
    expect(firstPage.totalPages).toBe(Math.ceil(domain.components.length / COMPONENTS_PER_PAGE));

    const seen = new Set<string>();
    for (let page = 1; page <= firstPage.totalPages; page += 1) {
      for (const item of paginateComponents(domain, page).items) {
        seen.add(item.id);
      }
    }
    expect(seen.size).toBe(domain.components.length);
  });

  it('clamps an out-of-range page request instead of returning an empty or crashing result', () => {
    const domain = LARGE_PROJECT_SCHEMA.domains.backend;
    const tooHigh = paginateComponents(domain, 999);
    expect(tooHigh.page).toBe(tooHigh.totalPages);
    expect(tooHigh.items.length).toBeGreaterThan(0);

    const tooLow = paginateComponents(domain, 0);
    expect(tooLow.page).toBe(1);
  });

  it('a small domain is exactly one page', () => {
    const page = paginateComponents(SMALL_PROJECT_SCHEMA.domains.frontend, 1);
    expect(page.totalPages).toBe(1);
    expect(page.items).toHaveLength(SMALL_PROJECT_SCHEMA.domains.frontend.components.length);
  });
});
