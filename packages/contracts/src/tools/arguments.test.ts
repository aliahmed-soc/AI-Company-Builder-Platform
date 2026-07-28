// ACBP-P5-003b — the canonical argument encoding (CDR-054; TOOL-002).
import { describe, test, expect } from 'vitest';
import { canonicalizeToolArguments as canon } from './arguments.js';

describe('canonicalizeToolArguments', () => {
  test('is STABLE — the same call encodes identically regardless of key order', () => {
    expect(canon({ b: 1, a: 2 })).toBe(canon({ a: 2, b: 1 }));
    expect(canon({ outer: { z: 1, a: 2 } })).toBe(canon({ outer: { a: 2, z: 1 } }));
  });

  test('array order IS meaningful and is preserved', () => {
    expect(canon([1, 2])).not.toBe(canon([2, 1]));
  });

  test('DISTINCT calls encode distinctly — the values JSON would have flattened stay apart', () => {
    // JSON.stringify turns all three of these into `null`, which would give one record to three different requests.
    const encodings = [canon(null), canon(Number.NaN), canon(Number.POSITIVE_INFINITY), canon(undefined)];
    expect(new Set(encodings).size).toBe(4);
  });

  test('distinguishes a missing key from an explicit null', () => {
    expect(canon({ a: 1 })).not.toBe(canon({ a: 1, b: null }));
    expect(canon({ a: 1, b: undefined })).not.toBe(canon({ a: 1, b: null }));
  });

  test('distinguishes types that stringify alike', () => {
    expect(canon('1')).not.toBe(canon(1));
    expect(canon(true)).not.toBe(canon('true'));
  });

  test('is TOTAL — nothing throws, because a request with no digest would be a request with no record', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic['self'] = cyclic;
    for (const value of [cyclic, () => 1, Symbol('s'), 10n, new Date('nope'), new Date('2026-07-28T00:00:00.000Z')]) {
      expect(() => canon(value)).not.toThrow();
      expect(typeof canon(value)).toBe('string');
    }
  });

  test('a cycle terminates rather than overflowing, and a repeated (non-cyclic) reference does not read as one', () => {
    const shared = { a: 1 };
    expect(canon({ x: shared, y: shared })).toBe(canon({ x: { a: 1 }, y: { a: 1 } }));
  });

  test('a Date encodes by instant, so two Dates for the same moment agree', () => {
    expect(canon(new Date('2026-07-28T00:00:00.000Z'))).toBe(canon(new Date(Date.UTC(2026, 6, 28))));
  });
});
