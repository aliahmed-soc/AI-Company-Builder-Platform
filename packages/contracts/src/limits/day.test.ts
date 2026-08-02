// @acbp/contracts — the UTC day key for daily caps (ACBP-P6-010; CDR-075 §3-G13).
import { describe, expect, it } from 'vitest';
import { usageDayStart, isUsageDayStart } from './day.js';

describe('usageDayStart', () => {
  it('buckets by UTC calendar day, not by the local one', () => {
    // The whole point of §3-G13. A daily cap read in local time resets at local midnight, so a founder in
    // UTC+14 would get a fresh daily allowance fourteen hours before one in UTC and the same account would
    // enforce two different ceilings depending on which server answered.
    expect(usageDayStart(new Date('2026-07-31T23:30:00.000Z'))).toBe('2026-07-31');
    expect(usageDayStart(new Date('2026-08-01T00:30:00.000Z'))).toBe('2026-08-01');
  });

  it('pads every component, so keys sort lexicographically and match ::date', () => {
    expect(usageDayStart(new Date('2026-01-05T12:00:00.000Z'))).toBe('2026-01-05');
  });

  it('throws on an invalid Date rather than formatting NaN into a key', () => {
    // Same reasoning as `usagePeriodStart`: a malformed key would reach `${dayStart}::date` in the aggregation
    // and raise a driver error deep inside a cap decision, where a thrown TypeError at the boundary is the
    // honest answer. A cap that errors mid-decision is a cap whose outcome depends on where it failed.
    expect(() => usageDayStart(new Date('nonsense'))).toThrow(TypeError);
  });
});

describe('isUsageDayStart', () => {
  it('accepts a padded calendar day and rejects everything else', () => {
    expect(isUsageDayStart('2026-08-02')).toBe(true);
    for (const bad of ['2026-8-02', '2026-08-2', '2026-08', '0000-01-01', '2026-13-01', '2026-08-32', '', 42, null]) {
      expect(isUsageDayStart(bad)).toBe(false);
    }
  });

  it('rejects year zero, which PostgreSQL has no concept of', () => {
    // `usagePeriodStart`'s guard exists because '0000-01-01' reaches `::date` and raises 22008 — a thrown error
    // where a typed refusal is the answer the caller should get. The same hole exists here.
    expect(isUsageDayStart('0000-06-15')).toBe(false);
  });
});
