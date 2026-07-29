// ACBP-P6-002 / CDR-067 §2-G10 — `toPolicyGateAnswer` is TOTAL over what it is handed.
//
// Raised by the independent adversarial review of the approval loosening. The mapping was the only link in the chain
// from stored policy to dispatcher gate that was not total over `unknown`: it forwarded `result.decision` verbatim.
// Nothing exploitable reached it today, because every decision is routed through `resolvePolicyDecision` inside the
// evaluator — but the value an unreadable decision landed on was `unavailable`, and `unavailable` is the ONE gate
// value the dispatcher's waiver spares. So the failure mode was not "denies wrongly", it was "an informational call
// proceeds on a decision nobody could read".
import { describe, test, expect } from 'vitest';
import { POLICY_DECISIONS } from '@acbp/contracts';
import { toPolicyGateAnswer } from './policy-service.js';
import type { EvaluateCompanyPolicyResult } from './policy-service.js';

/** A `decided` result carrying an arbitrary decision — the shape a future or malformed producer could hand over. */
const decided = (decision: unknown): EvaluateCompanyPolicyResult =>
  ({
    status: 'decided',
    decision,
    escalate: false,
    policyVersion: 1,
    evaluationId: '00000000-0000-4000-8000-000000000000',
    firedRuleIds: [],
    unevaluableRuleIds: [],
    untrustedRuleIds: [],
  }) as unknown as EvaluateCompanyPolicyResult;

describe('toPolicyGateAnswer — total over the decision it is handed', () => {
  test('every member of the closed vocabulary passes through unflattened', () => {
    // Collapsing `require_approval` onto `allow` is what created the CDR-066 §0 bypass; onto `deny` would refuse
    // actions a human is entitled to approve. Both directions matter, so assert identity across the whole set.
    for (const decision of POLICY_DECISIONS) {
      expect(toPolicyGateAnswer(decided(decision))).toEqual({ kind: decision });
    }
  });

  test('an UNREADABLE decision becomes `deny`, never `unavailable`', () => {
    // `unavailable` would be the dangerous landing value: the dispatcher's waiver spares it for the informational
    // class, so an unreadable decision would authorize rather than refuse.
    for (const junk of [undefined, null, '', 'ALLOW', 'allow ', 'unavailable', 'require approval', 0, 1, true, {}, [], 'proceed']) {
      expect(toPolicyGateAnswer(decided(junk))).toEqual({ kind: 'deny' });
    }
  });

  test('a decision the vocabulary GAINS later is refused until this mapping is updated', () => {
    // Widening `POLICY_DECISIONS` without revisiting the gate must fail closed, not fall through to a waivable value.
    expect(toPolicyGateAnswer(decided('require_two_approvals'))).toEqual({ kind: 'deny' });
  });

  test('every non-decided status denies, including one that does not exist yet', () => {
    expect(toPolicyGateAnswer({ status: 'no_usable_policy', reason: 'no_active_policy' })).toEqual({ kind: 'deny' });
    expect(toPolicyGateAnswer({ status: 'no_usable_policy', reason: 'policy_unreadable' })).toEqual({ kind: 'deny' });
    expect(toPolicyGateAnswer({ status: 'forbidden' })).toEqual({ kind: 'deny' });
    expect(toPolicyGateAnswer({ status: 'invented_later' } as unknown as EvaluateCompanyPolicyResult)).toEqual({ kind: 'deny' });
  });
});
