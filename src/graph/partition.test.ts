import { describe, expect, it } from 'vitest';
import { adjustedRandIndex, jaccardOverlap, partitionFromEntries } from './partition.js';

const p = (record: Record<string, string>) => partitionFromEntries(Object.entries(record));

describe('adjustedRandIndex', () => {
  it('scores identical partitions 1', () => {
    const a = p({ x: 'A', y: 'A', z: 'B', w: 'B' });
    expect(adjustedRandIndex(a, a)).toBeCloseTo(1, 10);
  });

  it('is invariant to cluster labelling', () => {
    const a = p({ x: 'A', y: 'A', z: 'B', w: 'B' });
    const b = p({ x: 'zzz', y: 'zzz', z: 'aaa', w: 'aaa' });
    expect(adjustedRandIndex(a, b)).toBeCloseTo(1, 10);
  });

  it('scores a completely different grouping well below 1', () => {
    const a = p({ x: 'A', y: 'A', z: 'B', w: 'B' });
    const b = p({ x: 'A', y: 'B', z: 'A', w: 'B' });
    expect(adjustedRandIndex(a, b)).toBeLessThan(0.5);
  });

  it('scores a near-identical grouping high', () => {
    const a = p({ a: '1', b: '1', c: '1', d: '2', e: '2', f: '2' });
    const b = p({ a: '1', b: '1', c: '2', d: '2', e: '2', f: '2' });
    expect(adjustedRandIndex(a, b)).toBeGreaterThan(0.3);
  });

  it('only compares keys the two partitions share', () => {
    // Files added or deleted between commits cannot agree or disagree; counting
    // them would report churn that is not regrouping.
    const a = p({ x: 'A', y: 'A', z: 'B' });
    const b = p({ x: 'A', y: 'A', z: 'B', added: 'C' });
    expect(adjustedRandIndex(a, b)).toBeCloseTo(1, 10);
  });

  it('handles a single shared key and an empty overlap', () => {
    expect(adjustedRandIndex(p({ x: 'A' }), p({ x: 'B' }))).toBe(1);
    expect(adjustedRandIndex(p({ x: 'A' }), p({ y: 'B' }))).toBe(1);
  });

  it('handles everything in one cluster on both sides', () => {
    const a = p({ x: 'A', y: 'A', z: 'A' });
    const b = p({ x: 'Q', y: 'Q', z: 'Q' });
    expect(adjustedRandIndex(a, b)).toBe(1);
  });
});

describe('jaccardOverlap', () => {
  it('scores identical partitions 1', () => {
    const a = p({ x: 'A', y: 'A', z: 'B' });
    expect(jaccardOverlap(a, a)).toBeCloseTo(1, 10);
  });

  it('reports the share of members a cluster kept', () => {
    const a = p({ a: '1', b: '1', c: '1', d: '1' });
    const b = p({ a: '1', b: '1', c: '1', d: '2' });
    // 3 of 4 kept together against a 4-member union -> 0.75 weighted by size.
    expect(jaccardOverlap(a, b)).toBeGreaterThan(0.5);
    expect(jaccardOverlap(a, b)).toBeLessThan(1);
  });

  it('scores a full split low', () => {
    const a = p({ a: '1', b: '1', c: '1', d: '1' });
    const b = p({ a: '1', b: '2', c: '3', d: '4' });
    expect(jaccardOverlap(a, b)).toBeLessThan(0.3);
  });

  it('handles empty overlap', () => {
    expect(jaccardOverlap(p({ x: 'A' }), p({ y: 'B' }))).toBe(1);
  });
});
