// @acbp/contracts — policy decision vocabulary and combination (ACBP-P6-001a; CDR-066 §3-G1/G2/G4; POL-005;
// ADR-010). Written BEFORE the implementation and watched to fail.
//
// The two properties under test are the ones the acceptance clause rests on: the decision set is ORDERED, and
// combining is "most restrictive wins" — including the case nobody writes a rule for, an EMPTY set of outcomes.
import { describe, test, expect } from 'vitest';
import {
  POLICY_DECISIONS,
  MOST_RESTRICTIVE_POLICY_DECISION,
  isPolicyDecision,
  policyRank,
  resolvePolicyDecision,
  combinePolicyDecisions,
  combinePolicyVerdicts,
  type PolicyVerdict,
} from './decision.js';

const JUNK: readonly unknown[] = ['ALLOW', 'Allow', 'allowed', 'permit', '', ' ', 'DENY', null, undefined, 0, 1, NaN, {}, [], ['allow'], true, false, Symbol('allow')];

describe('the decision vocabulary is CLOSED and ORDERED (G1)', () => {
  test('exactly ADR-010\'s three outputs, least → most restrictive', () => {
    expect([...POLICY_DECISIONS]).toEqual(['allow', 'require_approval', 'deny']);
  });

  test('the most restrictive decision is `deny`, derived from the order rather than restated', () => {
    expect(MOST_RESTRICTIVE_POLICY_DECISION).toBe('deny');
    expect(MOST_RESTRICTIVE_POLICY_DECISION).toBe(POLICY_DECISIONS[POLICY_DECISIONS.length - 1]);
  });

  test('the order is strictly increasing — the whole of POL-005 depends on it', () => {
    expect(policyRank('allow')).toBeLessThan(policyRank('require_approval'));
    expect(policyRank('require_approval')).toBeLessThan(policyRank('deny'));
  });

  test('the guard is deny-by-default at the boundary', () => {
    for (const v of POLICY_DECISIONS) expect(isPolicyDecision(v)).toBe(true);
    for (const bad of JUNK) expect(isPolicyDecision(bad)).toBe(false);
  });
});

describe('every unrecognised input resolves to the MOST RESTRICTIVE decision (G4)', () => {
  test('resolvePolicyDecision is total, and never invents permission', () => {
    for (const v of POLICY_DECISIONS) expect(resolvePolicyDecision(v)).toBe(v);
    for (const bad of JUNK) expect(resolvePolicyDecision(bad)).toBe('deny');
  });

  test('policyRank ranks an unrecognised value as the most restrictive, not as zero', () => {
    // Ranking junk 0 would make it the LEAST restrictive and silently win nothing — the exact inversion that turns a
    // combination rule into a permission leak.
    for (const bad of JUNK) expect(policyRank(bad)).toBe(policyRank('deny'));
  });
});

describe('combination is most-restrictive-wins (G2, POL-005)', () => {
  test('an EMPTY set of outcomes denies — a policy that said nothing has not permitted anything', () => {
    expect(combinePolicyDecisions([])).toBe('deny');
    expect(combinePolicyDecisions(undefined)).toBe('deny');
  });

  test('a single outcome is itself', () => {
    for (const v of POLICY_DECISIONS) expect(combinePolicyDecisions([v])).toBe(v);
  });

  test('the most restrictive present wins', () => {
    expect(combinePolicyDecisions(['allow', 'allow'])).toBe('allow');
    expect(combinePolicyDecisions(['allow', 'require_approval'])).toBe('require_approval');
    expect(combinePolicyDecisions(['allow', 'deny'])).toBe('deny');
    expect(combinePolicyDecisions(['require_approval', 'deny'])).toBe('deny');
    expect(combinePolicyDecisions(['allow', 'require_approval', 'deny'])).toBe('deny');
  });

  test('deny beats approval however they are ordered — POL-005 is not order-sensitive', () => {
    expect(combinePolicyDecisions(['deny', 'allow'])).toBe('deny');
    expect(combinePolicyDecisions(['deny', 'require_approval'])).toBe('deny');
    expect(combinePolicyDecisions(['require_approval', 'allow'])).toBe('require_approval');
  });

  test('ONE unrecognised outcome poisons the whole combination toward denial', () => {
    // A rule that produced a value we cannot read has not been evaluated. Ignoring it would let a broken rule act as
    // an implicit `allow`, which is the rule-gap risk ADR-010 §10 names.
    expect(combinePolicyDecisions(['allow', 'nonsense'])).toBe('deny');
    expect(combinePolicyDecisions(['allow', undefined])).toBe('deny');
  });
});

describe('verdicts carry escalation as a FIELD, never a fourth decision (G1)', () => {
  const v = (decision: PolicyVerdict['decision'], escalate = false): PolicyVerdict => ({ decision, escalate });

  test('an empty verdict set denies, and does not escalate on its own', () => {
    expect(combinePolicyVerdicts([])).toEqual({ decision: 'deny', escalate: false });
  });

  test('the winning decision is the most restrictive', () => {
    expect(combinePolicyVerdicts([v('allow'), v('require_approval')])).toEqual({ decision: 'require_approval', escalate: false });
  });

  test('escalation survives combination when a DENY asked for it', () => {
    expect(combinePolicyVerdicts([v('allow'), v('deny', true)])).toEqual({ decision: 'deny', escalate: true });
  });

  test('escalation is sticky across multiple denies — one rule asking is enough', () => {
    expect(combinePolicyVerdicts([v('deny', false), v('deny', true)])).toEqual({ decision: 'deny', escalate: true });
  });

  test('escalation on a NON-winning verdict does not leak onto a lesser decision', () => {
    // A `require_approval` outcome is not a denial, so it must never report itself as an escalated denial.
    expect(combinePolicyVerdicts([v('require_approval'), v('allow')])).toEqual({ decision: 'require_approval', escalate: false });
  });

  test('a malformed verdict denies rather than being skipped', () => {
    expect(combinePolicyVerdicts([{ decision: 'allow', escalate: false }, { decision: 'nope' } as unknown as PolicyVerdict])).toEqual({ decision: 'deny', escalate: false });
    expect(combinePolicyVerdicts([undefined as unknown as PolicyVerdict])).toEqual({ decision: 'deny', escalate: false });
  });

  test('a non-boolean escalate flag is not treated as true', () => {
    // Only a real `true` escalates. `'yes'` is a caller mistake, and reading it as escalation would page a human on a
    // malformed rule while reading it as false merely denies — the safer of the two wrong answers.
    expect(combinePolicyVerdicts([{ decision: 'deny', escalate: 'yes' } as unknown as PolicyVerdict])).toEqual({ decision: 'deny', escalate: false });
  });
});
