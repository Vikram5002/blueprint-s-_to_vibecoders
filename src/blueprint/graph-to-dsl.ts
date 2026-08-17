/**
 * Part A.3: the visual editor's only connection to the compiler.
 *
 * A drag-and-drop edit produces a `BlueprintGraph` — nodes and edges with no
 * meaning of their own — and this file's one function turns it into DSL
 * text. That text is then handed to the exact same `compileBlueprint` a
 * typed `.txt` file goes through (see `src/server/blueprint-api.ts`'s
 * `/api/blueprint/compile` route). There is no second compiler here, no
 * graph-shaped `Constraint` builder living beside `dsl.ts`'s — this module's
 * entire job is serialisation, and `dsl.test.ts`'s and this file's own tests
 * both hold `compileBlueprint` to being the single place a `Constraint` gets
 * built. `graph-to-dsl.test.ts`'s acceptance test asserts the literal claim:
 * dragging out a rule and typing the same rule produce byte-identical
 * `Constraint[]` output, because both paths call the same function on the
 * same text.
 */

export interface BlueprintGraphNode {
  /** Client-generated, stable for the node's lifetime in the editor session. */
  readonly id: string;
  /** The DSL subject phrase this node currently represents. */
  readonly phrase: string;
  /** Unary `must not cycle`, attached to the node rather than an edge. */
  readonly mustNotCycle?: boolean;
}

export interface BlueprintGraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly relation: 'must-not-import' | 'may-only-import-via' | 'must-be-layer-above';
  /** Node id. Required by `may-only-import-via`; ignored otherwise. */
  readonly via?: string;
}

export interface BlueprintGraph {
  readonly nodes: readonly BlueprintGraphNode[];
  readonly edges: readonly BlueprintGraphEdge[];
}

/**
 * Serialises a visual graph into blueprint DSL text, one line per edge (in
 * the order given) followed by one line per `must not cycle` node.
 *
 * An edge referencing a node id absent from `nodes`, or a
 * `may-only-import-via` edge with no resolvable `via`, is dropped rather than
 * throwing — the same defensive stance the server takes toward any untrusted
 * request body, since this function runs on a payload a browser sent.
 * Deterministic: the same graph (same array order) always serialises to the
 * same text, because nothing here reorders or deduplicates.
 */
export function graphToDsl(graph: BlueprintGraph): string {
  const phraseById = new Map(graph.nodes.map((node) => [node.id, node.phrase]));
  const lines: string[] = [];

  for (const edge of graph.edges) {
    const from = nonEmptyPhrase(phraseById, edge.from);
    const to = nonEmptyPhrase(phraseById, edge.to);
    if (from === null || to === null) {
      continue;
    }

    if (edge.relation === 'may-only-import-via') {
      const via = edge.via === undefined ? null : nonEmptyPhrase(phraseById, edge.via);
      if (via === null) {
        continue;
      }
      lines.push(`${from} may only import ${to} via ${via}`);
    } else if (edge.relation === 'must-not-import') {
      lines.push(`${from} must not import ${to}`);
    } else {
      lines.push(`${from} must be layer above ${to}`);
    }
  }

  for (const node of graph.nodes) {
    if (node.mustNotCycle === true && node.phrase.trim() !== '') {
      lines.push(`${node.phrase} must not cycle`);
    }
  }

  return lines.join('\n');
}

function nonEmptyPhrase(phraseById: ReadonlyMap<string, string>, nodeId: string): string | null {
  const phrase = phraseById.get(nodeId);
  return phrase === undefined || phrase.trim() === '' ? null : phrase;
}
