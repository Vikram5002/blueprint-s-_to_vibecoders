/**
 * A small seeded PRNG.
 *
 * Louvain consults a random source to break ties and, optionally, to walk nodes
 * in random order. Left on Math.random the algorithm produces different
 * communities on every run, which would mean the tool regrouped a user's
 * modules each time they refreshed the page. That is as corrosive to trust as
 * inventing an edge: if the picture moves on its own, nothing it shows can be
 * relied on, and Week 9's commit-to-commit diffing would report architectural
 * change that never happened.
 *
 * mulberry32: 32-bit state, uniform enough for tie-breaking, and identical
 * across platforms and Node versions because every operation is integer.
 */
export type RandomSource = () => number;

export const DEFAULT_CLUSTER_SEED = 0x5eed_1e55;

export function createSeededRandom(seed: number): RandomSource {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
