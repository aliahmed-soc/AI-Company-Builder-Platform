// @acbp/contracts — account usage rollup contract tests (ACBP-P6-009; CDR-073).
//
// These cover the pure, provider-neutral half of the rollup: the PERIOD DERIVATION (CDR-073 §1-G8) and the
// figure arithmetic the rebuild and the reconciliation both run on. They matter more than their size suggests —
// CDR-073 §0's failure mode is "the number is wrong and nothing notices", and every one of these functions is a
// place a wrong number could come from silently.
import { describe, it, expect } from 'vitest';
import {
  USAGE_ROLLUP_LANES,
  usagePeriodStart,
  isUsagePeriodStart,
  emptyRollupFigures,
  addRollupFigures,
  rollupFigureDrift,
  lanesExceedingThreshold,
  type RollupFigures,
} from './rollup.js';

describe('usagePeriodStart (CDR-073 §1-G8 — the bucket is a pure function of the instant, in UTC)', () => {
  it('returns the first day of the instant\'s UTC month', () => {
    expect(usagePeriodStart(new Date('2026-08-17T13:45:12.000Z'))).toBe('2026-08-01');
  });

  it('buckets by UTC, not by any local zone (the determinism the ticket exists for)', () => {
    // 23:30 on 31 July UTC. In UTC+02:00 this instant is already 01:30 on 1 August — a local-zone bucket would
    // file it under August. CDR-073 §1-G8 requires the UTC month, so it stays in July no matter where this runs.
    expect(usagePeriodStart(new Date('2026-07-31T23:30:00.000Z'))).toBe('2026-07-01');
    // And the mirror case: 00:30 on 1 August UTC is still 22:30 on 31 July in UTC-02:00.
    expect(usagePeriodStart(new Date('2026-08-01T00:30:00.000Z'))).toBe('2026-08-01');
  });

  it('handles the year boundary in both directions', () => {
    expect(usagePeriodStart(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12-01');
    expect(usagePeriodStart(new Date('2027-01-01T00:00:00.000Z'))).toBe('2027-01-01');
  });

  it('zero-pads single-digit months so the value sorts lexicographically as a date', () => {
    expect(usagePeriodStart(new Date('2026-01-05T00:00:00.000Z'))).toBe('2026-01-01');
    expect(usagePeriodStart(new Date('2026-09-30T00:00:00.000Z'))).toBe('2026-09-01');
  });

  it('THROWS on an invalid date rather than emitting "NaN-NaN-01"', () => {
    // A silently malformed period key would become a real row and quietly split one period into two.
    expect(() => usagePeriodStart(new Date('not a date'))).toThrow(/invalid/i);
  });
});

describe('isUsagePeriodStart (the shape guard for a value arriving from outside)', () => {
  it('accepts a first-of-month ISO date', () => {
    expect(isUsagePeriodStart('2026-08-01')).toBe(true);
  });

  it('REJECTS a mid-month date — the period key is the first of the month, not any date', () => {
    expect(isUsagePeriodStart('2026-08-17')).toBe(false);
  });

  it('rejects impossible months and days', () => {
    expect(isUsagePeriodStart('2026-13-01')).toBe(false);
    expect(isUsagePeriodStart('2026-00-01')).toBe(false);
  });

  it('rejects timestamps, non-strings and empty input', () => {
    expect(isUsagePeriodStart('2026-08-01T00:00:00.000Z')).toBe(false);
    expect(isUsagePeriodStart('')).toBe(false);
    expect(isUsagePeriodStart(20260801)).toBe(false);
    expect(isUsagePeriodStart(null)).toBe(false);
    expect(isUsagePeriodStart(undefined)).toBe(false);
  });
});

describe('rollup figures (the arithmetic the rebuild and the reconciliation share)', () => {
  it('names exactly the four lanes CDR-073 §1-G7 admits, and no billable/credit lane', () => {
    expect([...USAGE_ROLLUP_LANES]).toEqual(['eventCount', 'inputTokens', 'outputTokens', 'estimatedCostMicros']);
    // D-02 is OPEN: a billable or credit lane here would bake a pricing model into the schema (CDR-073 §1-G7).
    expect(USAGE_ROLLUP_LANES.some((l) => /billable|credit/i.test(l))).toBe(false);
  });

  it('starts at zero on every lane', () => {
    expect(emptyRollupFigures()).toEqual({ eventCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 });
  });

  it('adds lane-wise', () => {
    const a: RollupFigures = { eventCount: 2, inputTokens: 100, outputTokens: 50, estimatedCostMicros: 900 };
    const b: RollupFigures = { eventCount: 3, inputTokens: 7, outputTokens: 11, estimatedCostMicros: 100 };
    expect(addRollupFigures(a, b)).toEqual({ eventCount: 5, inputTokens: 107, outputTokens: 61, estimatedCostMicros: 1000 });
  });

  it('does not mutate either operand (the rebuild folds over companies with this)', () => {
    const a: RollupFigures = { eventCount: 1, inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1 };
    const b: RollupFigures = { eventCount: 2, inputTokens: 2, outputTokens: 2, estimatedCostMicros: 2 };
    addRollupFigures(a, b);
    expect(a).toEqual({ eventCount: 1, inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1 });
    expect(b).toEqual({ eventCount: 2, inputTokens: 2, outputTokens: 2, estimatedCostMicros: 2 });
  });

  it('adds NEGATIVE figures, because a correction is a signed compensating entry (CDR-073 §1-G9)', () => {
    const events: RollupFigures = { eventCount: 4, inputTokens: 400, outputTokens: 200, estimatedCostMicros: 5000 };
    const corrections: RollupFigures = { eventCount: 0, inputTokens: -100, outputTokens: 0, estimatedCostMicros: -1250 };
    expect(addRollupFigures(events, corrections)).toEqual({
      eventCount: 4,
      inputTokens: 300,
      outputTokens: 200,
      estimatedCostMicros: 3750,
    });
  });
});

describe('rollupFigureDrift (CDR-073 §1-G11 — computed MINUS stored, per lane)', () => {
  it('is zero on every lane when the projection agrees with the ledger', () => {
    const f: RollupFigures = { eventCount: 9, inputTokens: 90, outputTokens: 45, estimatedCostMicros: 1234 };
    expect(rollupFigureDrift(f, { ...f })).toEqual(emptyRollupFigures());
  });

  it('is SIGNED, so an under-count and an over-count are distinguishable', () => {
    const computed: RollupFigures = { eventCount: 10, inputTokens: 100, outputTokens: 50, estimatedCostMicros: 2000 };
    const stored: RollupFigures = { eventCount: 8, inputTokens: 120, outputTokens: 50, estimatedCostMicros: 2000 };
    expect(rollupFigureDrift(computed, stored)).toEqual({
      eventCount: 2, // the projection is 2 events SHORT
      inputTokens: -20, // and 20 tokens OVER
      outputTokens: 0,
      estimatedCostMicros: 0,
    });
  });
});

describe('lanesExceedingThreshold (the alert decision — the VALUE is the owner\'s, CDR-073 §3)', () => {
  const threshold = { eventCount: 0, inputTokens: 10, outputTokens: 10, estimatedCostMicros: 100 };

  it('reports nothing when every lane is within tolerance', () => {
    const drift: RollupFigures = { eventCount: 0, inputTokens: 5, outputTokens: -9, estimatedCostMicros: 100 };
    expect(lanesExceedingThreshold(drift, threshold)).toEqual([]);
  });

  it('compares MAGNITUDE, so an over-count alerts exactly as an under-count does', () => {
    const under: RollupFigures = { eventCount: 0, inputTokens: 11, outputTokens: 0, estimatedCostMicros: 0 };
    const over: RollupFigures = { eventCount: 0, inputTokens: -11, outputTokens: 0, estimatedCostMicros: 0 };
    expect(lanesExceedingThreshold(under, threshold)).toEqual(['inputTokens']);
    expect(lanesExceedingThreshold(over, threshold)).toEqual(['inputTokens']);
  });

  it('is EXCLUSIVE — a drift exactly equal to the tolerance is within it', () => {
    const drift: RollupFigures = { eventCount: 0, inputTokens: 10, outputTokens: 0, estimatedCostMicros: 0 };
    expect(lanesExceedingThreshold(drift, threshold)).toEqual([]);
  });

  it('reports EVERY exceeding lane in the closed lane order, not just the first', () => {
    const drift: RollupFigures = { eventCount: 1, inputTokens: 50, outputTokens: 0, estimatedCostMicros: -500 };
    expect(lanesExceedingThreshold(drift, threshold)).toEqual(['eventCount', 'inputTokens', 'estimatedCostMicros']);
  });

  it('treats a zero tolerance as "any difference at all alerts"', () => {
    const drift: RollupFigures = { eventCount: 1, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 };
    expect(lanesExceedingThreshold(drift, threshold)).toEqual(['eventCount']);
  });
});
