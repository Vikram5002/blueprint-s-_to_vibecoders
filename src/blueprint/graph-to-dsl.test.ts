import { describe, expect, it } from 'vitest';
import { graphToDsl, type BlueprintGraph } from './graph-to-dsl.js';
import { compileBlueprint } from './dsl.js';
import type { ResolutionCandidate } from '../conformance/resolve-subject.js';

const MODULES: ResolutionCandidate[] = [
  { moduleId: 'm-api', label: 'api', directories: ['src/api'], fileCount: 1 },
  { moduleId: 'm-db', label: 'db', directories: ['src/db'], fileCount: 1 },
  { moduleId: 'm-shared', label: 'shared', directories: ['src/shared'], fileCount: 1 },
];

describe('graphToDsl', () => {
  it('serialises a single must-not-import edge', () => {
    const graph: BlueprintGraph = {
      nodes: [
        { id: 'n1', phrase: 'api' },
        { id: 'n2', phrase: 'db' },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', relation: 'must-not-import' }],
    };
    expect(graphToDsl(graph)).toBe('api must not import db');
  });

  it('serialises may-only-import-via with its via node', () => {
    const graph: BlueprintGraph = {
      nodes: [
        { id: 'n1', phrase: 'ui' },
        { id: 'n2', phrase: 'shared' },
        { id: 'n3', phrase: 'api' },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', relation: 'may-only-import-via', via: 'n3' }],
    };
    expect(graphToDsl(graph)).toBe('ui may only import shared via api');
  });

  it('serialises must-be-layer-above', () => {
    const graph: BlueprintGraph = {
      nodes: [
        { id: 'n1', phrase: 'api' },
        { id: 'n2', phrase: 'domain' },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', relation: 'must-be-layer-above' }],
    };
    expect(graphToDsl(graph)).toBe('api must be layer above domain');
  });

  it('serialises a must-not-cycle node with no edges', () => {
    const graph: BlueprintGraph = { nodes: [{ id: 'n1', phrase: 'domain', mustNotCycle: true }], edges: [] };
    expect(graphToDsl(graph)).toBe('domain must not cycle');
  });

  it('emits multiple lines in edge-then-cycle-node order', () => {
    const graph: BlueprintGraph = {
      nodes: [
        { id: 'n1', phrase: 'api' },
        { id: 'n2', phrase: 'db', mustNotCycle: true },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', relation: 'must-not-import' }],
    };
    expect(graphToDsl(graph)).toBe('api must not import db\ndb must not cycle');
  });

  it('drops an edge referencing a missing node rather than throwing', () => {
    const graph: BlueprintGraph = {
      nodes: [{ id: 'n1', phrase: 'api' }],
      edges: [{ id: 'e1', from: 'n1', to: 'ghost', relation: 'must-not-import' }],
    };
    expect(graphToDsl(graph)).toBe('');
  });

  it('drops a may-only-import-via edge with no via node', () => {
    const graph: BlueprintGraph = {
      nodes: [
        { id: 'n1', phrase: 'ui' },
        { id: 'n2', phrase: 'shared' },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', relation: 'may-only-import-via' }],
    };
    expect(graphToDsl(graph)).toBe('');
  });

  it('is deterministic for the same graph', () => {
    const graph: BlueprintGraph = {
      nodes: [
        { id: 'n1', phrase: 'api' },
        { id: 'n2', phrase: 'db' },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', relation: 'must-not-import' }],
    };
    expect(graphToDsl(graph)).toBe(graphToDsl(graph));
  });
});

describe('acceptance: a dragged rule and a typed rule compile identically', () => {
  it('produces byte-identical Constraint[] for must-not-import', () => {
    const graph: BlueprintGraph = {
      nodes: [
        { id: 'n1', phrase: 'api' },
        { id: 'n2', phrase: 'db' },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', relation: 'must-not-import' }],
    };
    const dragged = graphToDsl(graph);
    const typed = 'api must not import db';

    // The claim under test: the DSL text itself is identical, not just
    // "produces an equivalent constraint" — proving there is exactly one
    // text format and one compiler, never a graph-specific second path.
    expect(dragged).toBe(typed);

    const fromDrag = compileBlueprint({ text: dragged, location: 'blueprint.txt', modules: MODULES });
    const fromTyping = compileBlueprint({ text: typed, location: 'blueprint.txt', modules: MODULES });

    expect(JSON.stringify(fromDrag)).toBe(JSON.stringify(fromTyping));
    expect(fromDrag.constraints).toHaveLength(1);
    expect(fromDrag.constraints[0]?.id).toBe(fromTyping.constraints[0]?.id);
  });

  it('produces byte-identical Constraint[] for may-only-import-via', () => {
    const graph: BlueprintGraph = {
      nodes: [
        { id: 'n1', phrase: 'ui' },
        { id: 'n2', phrase: 'shared' },
        { id: 'n3', phrase: 'api' },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', relation: 'may-only-import-via', via: 'n3' }],
    };
    const dragged = graphToDsl(graph);
    const typed = 'ui may only import shared via api';
    expect(dragged).toBe(typed);

    const fromDrag = compileBlueprint({ text: dragged, location: 'blueprint.txt', modules: MODULES });
    const fromTyping = compileBlueprint({ text: typed, location: 'blueprint.txt', modules: MODULES });
    expect(JSON.stringify(fromDrag)).toBe(JSON.stringify(fromTyping));
  });

  it('produces byte-identical Constraint[] for must-not-cycle', () => {
    const graph: BlueprintGraph = { nodes: [{ id: 'n1', phrase: 'api', mustNotCycle: true }], edges: [] };
    const dragged = graphToDsl(graph);
    const typed = 'api must not cycle';
    expect(dragged).toBe(typed);

    const fromDrag = compileBlueprint({ text: dragged, location: 'blueprint.txt', modules: MODULES });
    const fromTyping = compileBlueprint({ text: typed, location: 'blueprint.txt', modules: MODULES });
    expect(JSON.stringify(fromDrag)).toBe(JSON.stringify(fromTyping));
  });

  it('holds across a multi-line graph, in order', () => {
    const graph: BlueprintGraph = {
      nodes: [
        { id: 'n1', phrase: 'api' },
        { id: 'n2', phrase: 'db' },
        { id: 'n3', phrase: 'shared', mustNotCycle: true },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', relation: 'must-not-import' },
        { id: 'e2', from: 'n2', to: 'n1', relation: 'must-be-layer-above' },
      ],
    };
    const dragged = graphToDsl(graph);
    const typed = 'api must not import db\ndb must be layer above api\nshared must not cycle';
    expect(dragged).toBe(typed);

    const fromDrag = compileBlueprint({ text: dragged, location: 'blueprint.txt', modules: MODULES });
    const fromTyping = compileBlueprint({ text: typed, location: 'blueprint.txt', modules: MODULES });
    expect(JSON.stringify(fromDrag)).toBe(JSON.stringify(fromTyping));
    expect(fromDrag.constraints).toHaveLength(3);
  });
});
