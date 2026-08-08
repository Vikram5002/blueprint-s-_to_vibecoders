/**
 * Typed access to graphology-communities-louvain.
 *
 * The package is CommonJS (`module.exports = louvain`) but ships a declaration
 * file written in ESM syntax. Under `module: NodeNext` TypeScript reads the
 * declaration as an ES module and resolves a default import to the namespace
 * object, so `louvain.detailed` does not typecheck even though it exists at
 * runtime. The same mismatch bit the `ignore` package in Week 1, where a newer
 * release with a proper `exports` map fixed it; there is no such release here.
 *
 * So the module is loaded through createRequire, which gets the real CommonJS
 * export, and the slice of its surface this project uses is declared below.
 * Narrow and explicit beats casting at the call site — and no `any`.
 */
import { createRequire } from 'node:module';
import type { RandomSource } from './rng.js';

export interface LouvainOptions {
  /** Edge attribute holding the weight, or a mapper. */
  readonly getEdgeWeight: string;
  readonly resolution: number;
  readonly rng: RandomSource;
  /** Randomised traversal order. Must be false for reproducible output. */
  readonly randomWalk: boolean;
}

export interface LouvainDetailedResult {
  /** node id -> community index. */
  readonly communities: Record<string, number>;
  readonly count: number;
  readonly modularity: number;
  readonly resolution: number;
}

interface LouvainModule {
  detailed(graph: unknown, options: LouvainOptions): LouvainDetailedResult;
}

const louvainModule = createRequire(import.meta.url)('graphology-communities-louvain') as LouvainModule;

export function detectCommunities(graph: unknown, options: LouvainOptions): LouvainDetailedResult {
  return louvainModule.detailed(graph, options);
}
