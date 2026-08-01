// @acbp/database — the bigint marshalling guard (ACBP-P6-009; CDR-073 §1-G14).
//
// This repo installs no `int8` type parser and migration 0051 introduces its FIRST bigint columns, so
// node-postgres hands these values back as STRINGS. Left unconverted, `"100" + "200"` is `"100200"` and a drift
// comparison passes on nonsense — CDR-073 §0's "the number is wrong and nothing notices", in one line of
// JavaScript. Every one of these cases is about that.
import { describe, it, expect } from 'vitest';
import { toRollupFigure } from './usage-rollup-repository.js';

describe('toRollupFigure (the only path by which a bigint becomes a JS number)', () => {
  it('converts the STRING form node-postgres actually returns for bigint', () => {
    expect(toRollupFigure('4200')).toBe(4200);
    expect(typeof toRollupFigure('4200')).toBe('number');
  });

  it('treats NULL as zero — `sum()` over zero rows is NULL, and a period with no usage is 0, not missing', () => {
    expect(toRollupFigure(null)).toBe(0);
  });

  it('passes a number through unchanged', () => {
    expect(toRollupFigure(0)).toBe(0);
    expect(toRollupFigure(17)).toBe(17);
  });

  it('accepts the bigint form, in case a future type parser starts returning it', () => {
    expect(toRollupFigure(10n)).toBe(10);
  });

  it('accepts NEGATIVE values — a correction sum is negative by construction (CDR-073 §1-G10a)', () => {
    expect(toRollupFigure('-1250')).toBe(-1250);
    expect(toRollupFigure(-3)).toBe(-3);
  });

  it('accepts exactly Number.MAX_SAFE_INTEGER (the boundary is inclusive)', () => {
    expect(toRollupFigure(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  // THE GUARD. Beyond 2^53 a JS number silently loses precision, so returning one would hand back a figure that
  // is wrong in the last digits and indistinguishable from a right one. Throwing is the only honest answer.
  it('THROWS above Number.MAX_SAFE_INTEGER rather than returning a silently rounded number', () => {
    expect(() => toRollupFigure('9007199254740993')).toThrow(/exceeds|safe/i);
    expect(() => toRollupFigure(9007199254740993n)).toThrow(/exceeds|safe/i);
  });

  it('THROWS below -Number.MAX_SAFE_INTEGER too — the bound is on magnitude', () => {
    expect(() => toRollupFigure('-9007199254740993')).toThrow(/exceeds|safe/i);
  });

  it('THROWS on a non-numeric string instead of yielding NaN', () => {
    // NaN would propagate silently through every sum and comparison downstream.
    expect(() => toRollupFigure('not a number')).toThrow();
    expect(() => toRollupFigure('')).toThrow();
  });

  it('THROWS on a fractional value — these lanes are integer counts and integer micro-units', () => {
    expect(() => toRollupFigure('12.5')).toThrow(/integer/i);
    expect(() => toRollupFigure(12.5)).toThrow(/integer/i);
  });

  it('THROWS on undefined — a missing column is a query bug, not a zero', () => {
    // Deliberately distinguished from `null`: NULL is a real SQL answer meaning "no rows summed", whereas
    // `undefined` means the column was never selected, and silently reading that as 0 would hide the mistake.
    expect(() => toRollupFigure(undefined)).toThrow();
  });
});
