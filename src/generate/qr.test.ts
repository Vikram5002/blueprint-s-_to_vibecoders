import { describe, expect, it } from 'vitest';
import { qrEncode } from './qr.js';

/**
 * Expected: python-qrcode (byte mode, level M, the same version and mask), as
 * a djb2 fingerprint of the module matrix - an independent encoder agreeing
 * module for module, including multi-block versions 8 and 10.
 */
const EXPECTED: readonly (readonly [string, number, number, string])[] = [
  ["a", 1, 5, '72f4479d'],
  ["HELLO", 1, 4, '13597fd9'],
  ["https://example.com", 2, 2, '75a45eb9'],
  ["https://vibe-blueprint.dev/pricing?plan=pro&ref=qr", 4, 2, '4d3030f0'],
  ["नमस्ते दुनिया", 3, 4, 'd8afa'],
  ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", 4, 0, 'f49f6bdf'],
  ["The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. ", 8, 4, 'f38eef81'],
  ["yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", 8, 1, 'cfef1e6e'],
  ["zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", 10, 1, 'a33f4896'],
];

function fingerprint(matrix: readonly (readonly boolean[])[]): string {
  let hash = 5381;
  for (const ch of matrix.map((row) => row.map((d) => (d ? '1' : '0')).join('')).join('')) hash = ((hash << 5) + hash + ch.charCodeAt(0)) >>> 0;
  return hash.toString(16);
}

describe('qr encoder', () => {
  it('matches python-qrcode module for module', () => {
    for (const [text, version, mask, want] of EXPECTED) {
      const code = qrEncode(text);
      expect([code.version, code.mask]).toEqual([version, mask]);
      expect(fingerprint(code.matrix)).toBe(want);
    }
  });

  it('refuses content beyond version 10', () => {
    expect(() => qrEncode('x'.repeat(300))).toThrow(/too long/);
  });
});
