import type { Constraint } from './verification-types';
import type { DomainName, DomainSpec, ProjectSchema } from './project-schema-types';
import { DOMAIN_NAMES } from './project-schema-types';

/**
 * Deterministic layered layout for the four fixed domain nodes.
 *
 * A user builds spatial memory of their own architecture. A graph that
 * rearranges itself on reload destroys that memory, and worse, makes real
 * structural change invisible — every reload would look identical to a
 * change. So this is a pure function of the schema's `dependsOn` graph, not
 * a physics simulation: no randomness, no iteration-to-convergence, no
 * insertion-order dependence. Same schema in, same positions out, always —
 * pinned by workflow-layout.test.ts calling this twice on separately
 * constructed (not object-identical) schemas with the same values.
 *
 * Algorithm: longest-path layering (a standard Sugiyama-style layered graph
 * technique) — a domain's layer is one more than the deepest of its
 * dependencies, and a domain with no dependencies sits at layer 0. Layer 0
 * is drawn at the bottom (the domains everything else stands on); higher
 * layers stack upward. Within a layer, domains are ordered by the fixed
 * `DOMAIN_NAMES` array — never by `Object.keys()` or insertion order, both
 * of which are not guaranteed stable in a way this project depends on.
 */

export interface DomainPosition {
  readonly x: number;
  readonly y: number;
}

export type DomainLayout = Readonly<Record<DomainName, DomainPosition>>;

const COLUMN_WIDTH = 240;
const ROW_HEIGHT = 160;

export function computeLayout(schema: ProjectSchema): DomainLayout {
  const layerByDomain = computeLayers(schema);

  const domainsByLayer = new Map<number, DomainName[]>();
  for (const name of DOMAIN_NAMES) {
    const layer = layerByDomain.get(name) ?? 0;
    const existing = domainsByLayer.get(layer);
    if (existing === undefined) {
      domainsByLayer.set(layer, [name]);
    } else {
      existing.push(name);
    }
  }

  // domainsByLayer always has at least one entry: DOMAIN_NAMES is fixed and non-empty.
  const maxLayer = Math.max(...domainsByLayer.keys());

  const positions = {} as Record<DomainName, DomainPosition>;
  for (const [layer, names] of domainsByLayer) {
    names.forEach((name, index) => {
      const xOffset = (index - (names.length - 1) / 2) * COLUMN_WIDTH;
      positions[name] = {
        x: xOffset,
        // Layer 0 (no dependencies) drawn at the bottom, deeper dependents above it.
        y: (maxLayer - layer) * ROW_HEIGHT,
      };
    });
  }

  return positions;
}

/**
 * Longest-path layering with a cycle guard. `dependsOn` describes intended
 * architecture, not a checked graph — nothing here assumes it is acyclic.
 * A domain revisited while still being computed (a cycle) is treated as
 * having no further dependencies for the purpose of *this* traversal, which
 * keeps the recursion finite and, since traversal order is always the fixed
 * `DOMAIN_NAMES` order, keeps the result deterministic even for a schema
 * that describes an (invalid) circular dependency.
 */
function computeLayers(schema: ProjectSchema): Map<DomainName, number> {
  const layers = new Map<DomainName, number>();
  const visiting = new Set<DomainName>();

  function layerOf(name: DomainName): number {
    const cached = layers.get(name);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(name)) {
      return 0;
    }

    visiting.add(name);
    const deps = schema.domains[name].dependsOn;
    const layer = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(layerOf));
    visiting.delete(name);

    layers.set(name, layer);
    return layer;
  }

  for (const name of DOMAIN_NAMES) {
    layerOf(name);
  }
  return layers;
}

export interface WorkflowEdge {
  readonly id: string;
  readonly from: DomainName;
  readonly to: DomainName;
  /**
   * `ProjectSchema` has no numeric edge-weight field — `dependsOn` is a
   * presence/absence declaration. Approximated as the dependent domain's
   * component count: a domain with more components has more of its surface
   * area that could plausibly rely on the dependency, which is the closest
   * proxy the real schema supports for "how heavily is this edge used."
   * Documented here rather than left to look like a real measured count.
   */
  readonly weight: number;
  /** The stated rule for this dependency, if the schema's authors wrote one. Not every edge has one. */
  readonly constraint: Constraint | null;
}

/**
 * One edge per `dependsOn` declaration — `from` depends on `to`, drawn
 * from -> to. If `schema.constraints` states a rule between the same two
 * domains (matched by phrase against `DomainName`, either direction, since a
 * rule can be written as "frontend must not import database" or "database
 * must not be imported by frontend"), that constraint is attached; clicking
 * the edge shows exactly that constraint, or an explicit "no rule stated"
 * if none matched — never a fabricated one.
 */
export function deriveEdges(schema: ProjectSchema): readonly WorkflowEdge[] {
  const edges: WorkflowEdge[] = [];
  for (const from of DOMAIN_NAMES) {
    for (const to of schema.domains[from].dependsOn) {
      edges.push({
        id: `${from}->${to}`,
        from,
        to,
        weight: schema.domains[from].components.length,
        constraint: findDomainConstraint(schema, from, to),
      });
    }
  }
  return edges;
}

function findDomainConstraint(
  schema: ProjectSchema,
  from: DomainName,
  to: DomainName,
): Constraint | null {
  return (
    schema.constraints.find((constraint) => {
      const subject = constraint.subject.phrase.trim().toLowerCase();
      const object = constraint.object.phrase.trim().toLowerCase();
      return (subject === from && object === to) || (subject === to && object === from);
    }) ?? null
  );
}

// --- Scale guard -----------------------------------------------------------

/**
 * React Flow degrades badly past roughly 1000 nodes. This schema only ever
 * produces four graph nodes (one per domain) regardless of component
 * count — components are never rendered as individual graph nodes, only
 * listed — but a domain's component *list* still has to stay usable at real
 * scale, so it is paginated rather than rendered flat past this size.
 */
export const DIRECT_LIST_LIMIT = 300;
export const COMPONENTS_PER_PAGE = 50;

export function exceedsDirectListLimit(domain: DomainSpec): boolean {
  return domain.components.length > DIRECT_LIST_LIMIT;
}

export interface ComponentPage {
  readonly items: readonly DomainSpec['components'][number][];
  readonly page: number;
  readonly totalPages: number;
  readonly totalComponents: number;
}

export function paginateComponents(domain: DomainSpec, requestedPage: number): ComponentPage {
  const totalComponents = domain.components.length;
  const totalPages = Math.max(1, Math.ceil(totalComponents / COMPONENTS_PER_PAGE));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const start = (page - 1) * COMPONENTS_PER_PAGE;

  return {
    items: domain.components.slice(start, start + COMPONENTS_PER_PAGE),
    page,
    totalPages,
    totalComponents,
  };
}
