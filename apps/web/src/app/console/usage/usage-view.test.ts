/*
 * ACBP-FE-018 — the usage view model.
 *
 * The cases that matter are the ones where a plausible simplification produces a screen that lies about money:
 * collapsing "never computed" into "zero", dividing micros as a float, or letting a cost estimate read as a bill.
 */
import { describe, expect, test } from 'vitest';
import { toUsageView, microsToCostUnits, periodLabelOf, type AccountUsageWire } from './usage-view.js';

function usage(over: Partial<AccountUsageWire> = {}): AccountUsageWire {
  return {
    periodStart: '2026-08-01',
    eventCount: 12,
    inputTokens: 48_300,
    outputTokens: 9_140,
    estimatedCostMicros: 470_000,
    computedAt: '2026-08-19T09:00:00.000Z',
    ...over,
  };
}

describe('a measured zero is not a missing figure', () => {
  const zero = () => toUsageView(usage({ eventCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 }));
  const absent = () => toUsageView(null, '2026-08-01');

  test('computed-and-zero says the period was MEASURED', () => {
    const v = zero();
    expect(v.state).toBe('computed');
    expect(v.isMeasuredZero).toBe(true);
    expect(v.headline).toContain('measured');
    expect(v.note).toContain('measured zero');
  });

  test('never-computed says the PROJECTION is missing, and never says zero', () => {
    const v = absent();
    expect(v.state).toBe('never_computed');
    expect(v.isMeasuredZero).toBe(false);
    // The word "zero" may appear only in the phrase that DENIES it is zero.
    expect(v.note).toContain('not the same as zero');
    expect(v.headline).not.toContain('zero');
  });

  test('THE ROW THIS FILE EXISTS FOR: the two states never share copy', () => {
    // The backlog row: "Zero usage is an explicit computed zero, not a blank." Both states have no numbers to
    // show; only one of them is a measurement.
    expect(zero().headline).not.toBe(absent().headline);
    expect(zero().note).not.toBe(absent().note);
  });

  test('a measured zero still renders its four figures; an absent projection renders none', () => {
    // The zero must be SHOWN as zeroes, because it is a real reading. The absence has nothing to show.
    expect(zero().figures).toHaveLength(4);
    expect(zero().figures.find((f) => f.key === 'eventCount')?.value).toBe('0 calls');
    expect(absent().figures).toEqual([]);
  });

  test('the absent state offers no rebuild, because no route reaches one', () => {
    expect(absent().note).toContain('not something this console can trigger');
  });
});

describe('micros are converted in integer arithmetic, because this is money', () => {
  test('the float trap: 1250 micros is exactly 0.00125 cost units', () => {
    // `1250 / 1_000_000` is 0.0012500000000000002 in binary floating point. A screen that formatted THAT has
    // invented a digit.
    expect(microsToCostUnits(1_250)).toBe('0.00125');
  });

  test('a whole cost unit keeps two decimal places rather than collapsing to one', () => {
    expect(microsToCostUnits(1_000_000)).toBe('1.00');
    expect(microsToCostUnits(100_000)).toBe('0.10');
    expect(microsToCostUnits(0)).toBe('0.00');
  });

  test('large values carry thousands separators', () => {
    expect(microsToCostUnits(1_234_567_000_000)).toBe('1,234,567.00');
  });

  test('very small values are shown, not rounded away to zero', () => {
    // At around 5 micros per input token, real usage is a tiny fraction of a cost unit. Rounding to 2 places would
    // display every small account's spend as 0.00.
    expect(microsToCostUnits(5)).toBe('0.000005');
    expect(microsToCostUnits(37)).toBe('0.000037');
  });

  test('a non-finite value degrades to 0.00 rather than rendering NaN at a founder', () => {
    expect(microsToCostUnits(Number.NaN)).toBe('0.00');
  });
});

describe('every figure carries its unit in text', () => {
  test('no figure value is a bare numeral', () => {
    // The row's accessibility line. A value read aloud on its own must still say what it counts.
    for (const f of toUsageView(usage()).figures) {
      expect(f.value).not.toMatch(/^[\d,]+$/);
      expect(f.value.length).toBeGreaterThan(1);
    }
  });

  test('counts are singular or plural correctly', () => {
    expect(toUsageView(usage({ eventCount: 1 })).figures.find((f) => f.key === 'eventCount')?.value).toBe('1 call');
    expect(toUsageView(usage({ eventCount: 2 })).figures.find((f) => f.key === 'eventCount')?.value).toBe('2 calls');
  });

  test('token figures name the unit', () => {
    const v = toUsageView(usage());
    expect(v.figures.find((f) => f.key === 'inputTokens')?.value).toBe('48,300 tokens');
    expect(v.figures.find((f) => f.key === 'outputTokens')?.value).toBe('9,140 tokens');
  });
});

describe('the cost is presented as an estimate and never as a bill', () => {
  test('the VALUE itself carries the unit and the hedge, not just the label', () => {
    // A figure quoted on its own — read aloud, or copied — must not become a bare "0.47" with the unit and the
    const cost = toUsageView(usage()).figures.find((f) => f.key === 'estimatedCost');
    expect(cost?.value).toBe('0.47 cost units (estimated)');
  });

  test('the note denies every billing reading explicitly', () => {
    const note = toUsageView(usage()).figures.find((f) => f.key === 'estimatedCost')?.note ?? '';
    for (const denial of ['not an invoice', 'not a balance', 'not what you will be charged']) {
      expect(note).toContain(denial);
    }
    expect(note).toContain('records NO currency');
  });

  test('the SUMMARY copy contains no billing vocabulary at all — not even in a denial', () => {
    /*
     * The read's own header: "Any surface presenting these figures as an invoice would be asserting something the
     * platform does not claim."
     *
     * THE RULE IS DELIBERATELY STRICTER FOR THE SUMMARY THAN FOR THE COST NOTE, and the first version of this
     * copy failed it. The headline and note are what a founder takes in at a glance, and a glance does not carry
     * a negation reliably — "not a bill" and "a bill" skim the same. The explicit denials belong on the cost
     * figure itself, where they are read alongside the number they qualify (asserted in the test above).
     */
    const v = toUsageView(usage());
    const affirmative = [v.headline, v.note, v.computedAtLabel].join(' ').toLowerCase();
    for (const word of ['invoice', 'bill', 'due', 'owed', 'payment', 'balance']) {
      expect(affirmative).not.toContain(word);
    }
  });

  test('NO CURRENCY SYMBOL OR CODE APPEARS ANYWHERE, because the platform records none', () => {
    /*
     * THE DEFECT THIS PINS, and the first draft of this screen shipped it: the cost was rendered as
     * "$0.47 estimated (US dollars)".
     *
     * Migration 0017 defines the lane as "integer micro-units (1e-6 of the COST UNIT)" — deliberately unnamed —
     * and nothing in `packages/contracts/src/usage` or `packages/core/src/usage` names a currency at all. The one
     * place a currency exists in this repository is a single provider adapter's published list price, which is a
     * property of that adapter and not of this figure. Printing a `$` asserted something the server never said.
     */
    const v = toUsageView(usage());
    const everything = [v.headline, v.note, v.computedAtLabel, ...v.figures.flatMap((f) => [f.label, f.value, f.note])].join(' ');
    for (const symbol of ['$', '€', '£', '¥', 'USD', 'EUR', 'GBP', 'dollar', 'cent', 'euro']) {
      expect(everything.toLowerCase()).not.toContain(symbol.toLowerCase());
    }
    // And the unit that IS claimed is the one the migration names.
    expect(everything).toContain('cost units');
    expect(everything).toContain('micro-units');
  });

  test('the projection timestamp is surfaced, so a stale figure is recognisable as stale', () => {
    expect(toUsageView(usage()).computedAtLabel).toContain('2026-08-19T09:00:00.000Z');
  });
});

describe('the period label', () => {
  test('a well-formed period start reads as a month', () => {
    expect(periodLabelOf('2026-08-01')).toBe('August 2026');
  });

  test('an unparseable value is returned AS IS rather than guessed at', () => {
    // Inventing a date from a value the server did not send is how a founder ends up reading the wrong month.
    expect(periodLabelOf('not-a-period')).toBe('not-a-period');
    expect(periodLabelOf('2026-08-15')).toBe('2026-08-15');
  });

  test('the absent state still names which period is missing', () => {
    expect(toUsageView(null, '2026-08-01').periodLabel).toBe('August 2026');
  });
});
