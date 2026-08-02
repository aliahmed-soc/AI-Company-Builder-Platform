// @acbp/core — assembling CDR-008's four caps and the policy observation (ACBP-P6-010; CDR-075 §3-G1/G4/G5).
import { describe, expect, it } from 'vitest';
import { USAGE_CAP_DEFAULTS, type UsageCapsConfig } from '@acbp/config';
import { evaluateCaps, TRUST_CRITICAL_DIMENSIONS } from '@acbp/contracts';
import { observedCapsFrom, spendingLimitObservation } from './usage-caps.js';

const cfg: UsageCapsConfig = USAGE_CAP_DEFAULTS;
const spend = (dayMicros: number | null, monthMicros: number | null) => ({ dayMicros, monthMicros });

describe('observedCapsFrom', () => {
  it('produces exactly the four caps CDR-008 §8 defines, one per scope and period', () => {
    const caps = observedCapsFrom(cfg, spend(0, 0), spend(0, 0));
    expect(caps.map((c) => `${c.cap.scope}/${c.cap.period}`).sort()).toEqual([
      'account/day',
      'account/month',
      'company/day',
      'company/month',
    ]);
  });

  it('derives the account ceiling as company x multiplier, never as a second stored figure', () => {
    // CDR-008 states the account ceiling RELATIVELY ("3x company cap"). Deriving it keeps the two from drifting
    // the first time someone edits only the company value — an account cap silently below its own company cap
    // would make the company cap unreachable and turn the per-company number into decoration.
    const caps = observedCapsFrom(cfg, spend(0, 0), spend(0, 0));
    const limitOf = (scope: string, period: string) => caps.find((c) => c.cap.scope === scope && c.cap.period === period)?.cap.limitMicros;
    expect(limitOf('account', 'day')).toBe(cfg.companyDailyMicros * cfg.accountMultiplier);
    expect(limitOf('account', 'month')).toBe(cfg.companyMonthlyMicros * cfg.accountMultiplier);
  });

  it('carries the configured soft threshold onto every cap', () => {
    const caps = observedCapsFrom({ ...cfg, softPercent: 60 }, spend(0, 0), spend(0, 0));
    expect(caps.every((c) => c.cap.softPercent === 60)).toBe(true);
  });

  it('pairs each cap with the spend for ITS OWN scope and period', () => {
    // The defect this catches is a copy-paste one: reading the company figure into the account cap makes the
    // account ceiling unreachable for a multi-company account, which is silent and always in the customer's
    // favour — the shape that survives longest.
    const caps = observedCapsFrom(cfg, spend(11, 22), spend(33, 44));
    const at = (scope: string, period: string) => caps.find((c) => c.cap.scope === scope && c.cap.period === period)?.spentMicros;
    expect(at('company', 'day')).toBe(11);
    expect(at('company', 'month')).toBe(22);
    expect(at('account', 'day')).toBe(33);
    expect(at('account', 'month')).toBe(44);
  });

  it('passes an unreadable total through as null so evaluateCaps can HALT on it', () => {
    // CDR-075 §3-G6. Substituting 0 for an unreadable total would read as "nothing spent yet" and allow the
    // call — a cap that fails open is not a cap.
    const caps = observedCapsFrom(cfg, spend(null, 0), spend(0, 0));
    expect(caps.find((c) => c.cap.scope === 'company' && c.cap.period === 'day')?.spentMicros).toBeNull();
    expect(evaluateCaps(caps).outcome).toBe('halt');
  });

  it('composes with evaluateCaps end to end at the interim values', () => {
    // $5/day interim = 5_000_000 micros. At exactly the cap the call is refused, which is the ≤1 increment bound.
    expect(evaluateCaps(observedCapsFrom(cfg, spend(4_999_999, 0), spend(0, 0))).outcome).toBe('allow');
    expect(evaluateCaps(observedCapsFrom(cfg, spend(5_000_000, 0), spend(0, 0))).outcome).toBe('block');
    // 75% of $5 = 3_750_000 → soft alert, work proceeds.
    const soft = evaluateCaps(observedCapsFrom(cfg, spend(3_750_000, 0), spend(0, 0)));
    expect(soft.outcome).toBe('allow');
    if (soft.outcome !== 'allow') throw new Error('unreachable');
    expect(soft.softBreaches).toHaveLength(1);
  });
});

describe('spendingLimitObservation', () => {
  it('is STRUCTURED-provenanced, because spending_limit is trust-critical', () => {
    // ADR-010 §5: trust-critical determinations come from the registry and structured payload fields, NEVER from
    // model text. `spending_limit` is in TRUST_CRITICAL_DIMENSIONS, so claiming `model` here would route a real
    // ledger figure down the untrusted path, and claiming `registry` would be false — it came from the ledger.
    expect(TRUST_CRITICAL_DIMENSIONS).toContain('spending_limit');
    expect(spendingLimitObservation(1234)?.provenance).toBe('structured');
  });

  it('carries the spend, which is what at_or_over_limit compares against the rule operand', () => {
    expect(spendingLimitObservation(1234)?.value).toBe(1234);
  });

  it('yields undefined when the spend is unreadable, so the dimension stays UNEVALUABLE rather than reading as zero', () => {
    // The subtle one. An unreadable total must NOT become `0`: zero is under every conceivable cap, so a rule
    // that should have blocked would allow. Returning undefined leaves the dimension unobserved, and CDR-066
    // §3-G9 makes an unevaluable dimension contribute deny — fail-closed, which is the correct direction.
    expect(spendingLimitObservation(null)).toBeUndefined();
  });
});
