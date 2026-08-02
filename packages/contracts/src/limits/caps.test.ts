// @acbp/contracts — cap evaluation (ACBP-P6-010; CDR-075 §3-G3/G5/G6/G7; NFR-015; POL-001).
import { describe, expect, it } from 'vitest';
import { evaluateCaps, softThresholdMicros, type CapDefinition, type ObservedCap } from './caps.js';

const cap = (over: Partial<CapDefinition> = {}): CapDefinition => ({
  scope: 'company',
  period: 'day',
  limitMicros: 5_000_000,
  softPercent: 75,
  ...over,
});
const observed = (spentMicros: number | null, over: Partial<CapDefinition> = {}): ObservedCap => ({ cap: cap(over), spentMicros });

describe('softThresholdMicros', () => {
  it('is integer math, never a float multiply', () => {
    // Money discipline: micro-units are integers everywhere. `5_000_000 * 0.75` happens to be exact, but a
    // fraction that is not representable in binary would produce a threshold that is off by a fraction of a
    // micro-unit and compares wrong at the boundary. Percent-as-integer avoids the class entirely.
    expect(softThresholdMicros(cap())).toBe(3_750_000);
    expect(Number.isInteger(softThresholdMicros({ ...cap(), limitMicros: 1_000_001, softPercent: 33 }))).toBe(true);
  });

  it('floors rather than rounds, so the alert never fires later than the stated percentage', () => {
    expect(softThresholdMicros({ ...cap(), limitMicros: 10, softPercent: 75 })).toBe(7);
  });
});

describe('evaluateCaps', () => {
  it('allows when every cap is under its soft threshold', () => {
    const d = evaluateCaps([observed(1_000_000)]);
    expect(d.outcome).toBe('allow');
    if (d.outcome !== 'allow') throw new Error('unreachable');
    expect(d.softBreaches).toHaveLength(0);
  });

  it('blocks AT the limit, not past it — this is what bounds the overrun to one increment', () => {
    // NFR-015 allows at most ONE billing increment of overrun. That bound holds because the check runs BEFORE
    // the call and refuses at `spent >= limit`: the most that can be exceeded is the one call already decided.
    // `spent > limit` would let a call through at exactly the cap and overrun by two.
    const atLimit = evaluateCaps([observed(5_000_000)]);
    expect(atLimit.outcome).toBe('block');

    const oneUnder = evaluateCaps([observed(4_999_999)]);
    expect(oneUnder.outcome).not.toBe('block');
  });

  it('raises a soft breach AT the threshold and still allows the work', () => {
    // CDR-075 §3-G7: a soft alert is an event, never a block. Blocking at 75% would be a hard cap wearing a soft
    // cap's name, and the founder would have lost a quarter of the budget they were told they had.
    const d = evaluateCaps([observed(3_750_000)]);
    expect(d.outcome).toBe('allow');
    if (d.outcome !== 'allow') throw new Error('unreachable');
    expect(d.softBreaches).toHaveLength(1);
    expect(d.softBreaches[0]?.cap.scope).toBe('company');
  });

  it('names WHICH cap blocked, at which scope and period', () => {
    // CDR-075 §4-G4.3: a refusal a founder cannot attribute is indistinguishable from a bug in their own
    // product. "Blocked" alone sends them debugging the wrong system.
    const d = evaluateCaps([
      observed(0, { scope: 'company', period: 'day' }),
      observed(200_000_000, { scope: 'account', period: 'month', limitMicros: 150_000_000 }),
    ]);
    expect(d.outcome).toBe('block');
    if (d.outcome !== 'block') throw new Error('unreachable');
    expect(d.blocking.cap.scope).toBe('account');
    expect(d.blocking.cap.period).toBe('month');
    expect(d.blocking.spentMicros).toBe(200_000_000);
  });

  it('HALTS when a cap cannot be read, and says so distinctly from being over budget', () => {
    // CDR-075 §3-G6. Two failures that both stop work and mean opposite things: "you have spent your budget" is
    // the founder's to act on, "we cannot tell what you have spent" is ours. Reporting the second as the first
    // sends someone to top up an account that was never the problem.
    const d = evaluateCaps([observed(null)]);
    expect(d.outcome).toBe('halt');
    if (d.outcome !== 'halt') throw new Error('unreachable');
    expect(d.unreadable.scope).toBe('company');
  });

  it('halts on an unreadable cap even when another cap would have blocked first', () => {
    // Order must not decide this. A blocking cap does not make the unreadable one readable, and answering
    // "blocked" would claim knowledge of a total nobody has.
    const d = evaluateCaps([observed(999_999_999), observed(null, { scope: 'account' })]);
    expect(d.outcome).toBe('halt');
  });

  it('halts on a nonsensical cap rather than ignoring it', () => {
    // A negative or non-finite limit is a configuration defect. Skipping it would silently drop a control the
    // owner believes is active; treating it as zero would block everything. Halting says what is true: this cap
    // cannot be evaluated.
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(evaluateCaps([observed(0, { limitMicros: bad })]).outcome).toBe('halt');
    }
    for (const bad of [0, 100, -5, 1.5]) {
      expect(evaluateCaps([observed(0, { softPercent: bad })]).outcome).toBe('halt');
    }
  });

  it('treats a zero limit as "no spend permitted", not as "no cap"', () => {
    // The dangerous misreading: 0 is falsy, so an `if (!limit)` guard anywhere upstream would turn the
    // strictest possible cap into no cap at all.
    expect(evaluateCaps([observed(0, { limitMicros: 0 })]).outcome).toBe('block');
  });

  it('allows when there are no caps at all — an absent cap is not a denial', () => {
    // CDR-075 §2-G2.4. Rules restrict; they do not grant. A company with no configured cap is unrestricted by
    // this dimension, exactly as it was before this ticket. Making "unconfigured" mean deny is the CDR-067
    // landmine from the other side.
    const d = evaluateCaps([]);
    expect(d.outcome).toBe('allow');
  });

  it('reports every soft breach, not just the first', () => {
    const d = evaluateCaps([observed(4_000_000), observed(4_000_000, { scope: 'account' })]);
    expect(d.outcome).toBe('allow');
    if (d.outcome !== 'allow') throw new Error('unreachable');
    expect(d.softBreaches).toHaveLength(2);
  });

  it('still reports soft breaches alongside a block', () => {
    // The block is the headline, but an operator reading the incident wants to know what else was near its
    // ceiling — a founder blocked on the daily cap while the monthly one sits at 90% has a different problem
    // from one blocked on a quiet month.
    const d = evaluateCaps([observed(5_000_000), observed(4_000_000, { scope: 'account' })]);
    expect(d.outcome).toBe('block');
    if (d.outcome !== 'block') throw new Error('unreachable');
    expect(d.softBreaches).toHaveLength(1);
    expect(d.softBreaches[0]?.cap.scope).toBe('account');
  });
});
