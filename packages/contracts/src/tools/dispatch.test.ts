// ACBP-P5-003b — the dispatch decision, made executable (CDR-054; TOOL-002/003; WORK-005; ADR-012).
//
// This is the gate. Every test below is a statement about what may execute, so each one is written to fail LOUDLY
// rather than to pass conveniently: the default posture of every fixture is "everything is fine", and each test
// breaks exactly one thing.
import { describe, test, expect } from 'vitest';
import {
  TOOL_CALL_OUTCOMES,
  TOOL_DENIAL_REASONS,
  isToolCallOutcome,
  isToolDenialReason,
  decideDispatch,
  CLASSES_THAT_PROCEED_WITHOUT_A_GATE,
  type DispatchRequestFacts,
} from './dispatch.js';
import { RISK_CLASSES, MOST_RESTRICTIVE_RISK_CLASS } from './risk-class.js';
import { toolCallRequested } from '../audit/audit.js';

/** Everything permissible. Each test breaks ONE field, so a passing result always names its own cause. */
const clear = (over: Partial<DispatchRequestFacts> = {}): DispatchRequestFacts => ({
  toolId: 'web_research',
  registered: true,
  riskClass: 'informational',
  allowlist: ['web_research', 'memory_read'],
  stop: { kind: 'clear' },
  policy: { kind: 'allow' },
  approval: { kind: 'allow' },
  ...over,
});

describe('the closed vocabularies', () => {
  test('outcomes are exactly canon\'s five, and `unconfirmed` is one of them (TOOL-002)', () => {
    expect([...TOOL_CALL_OUTCOMES]).toEqual(['requested', 'denied', 'succeeded', 'failed', 'unconfirmed']);
    // The failure clause is explicit: "Missing receipt marks the call outcome 'unconfirmed', never 'succeeded'."
    expect(TOOL_CALL_OUTCOMES).toContain('unconfirmed');
  });

  test('both guards are deny-by-default at the boundary', () => {
    for (const v of TOOL_CALL_OUTCOMES) expect(isToolCallOutcome(v)).toBe(true);
    for (const v of TOOL_DENIAL_REASONS) expect(isToolDenialReason(v)).toBe(true);
    for (const bad of ['SUCCEEDED', 'ok', '', 42, null, undefined, {}, ['denied']]) {
      expect(isToolCallOutcome(bad)).toBe(false);
      expect(isToolDenialReason(bad)).toBe(false);
    }
  });

  test('a denial reason never carries free text — the set is closed and lowercase', () => {
    for (const r of TOOL_DENIAL_REASONS) expect(r).toMatch(/^[a-z][a-z_]*$/);
  });

  test('the requested event OMITS tool_version when there is none — audit metadata takes scalars only', () => {
    // Found by hosted CI: sending `tool_version: null` throws "Audit metadata value type is not allowed", which would
    // have made every unregistered-tool refusal fail to audit — the exact attempt TOOL-001 most wants recorded.
    const unregistered = toolCallRequested({ callId: 'c1', toolId: 'ghost', toolVersion: null, riskClass: 'informational', externalEffect: false, denialReason: 'not_registered' });
    expect(Object.keys(unregistered.metadata)).not.toContain('tool_version');
    const registered = toolCallRequested({ callId: 'c2', toolId: 'web_research', toolVersion: 3, riskClass: 'informational', externalEffect: false });
    expect(registered.metadata).toMatchObject({ tool_version: 3 });
  });
});

describe('decideDispatch — the authorized path', () => {
  test('a registered, allowlisted, unstopped, policy-allowed, approved call is authorized', () => {
    expect(decideDispatch(clear())).toEqual({ kind: 'authorized', riskClass: 'informational' });
  });

  test('the resolved class is returned, so a caller never has to re-resolve it', () => {
    const d = decideDispatch(clear({ riskClass: 'internal_reversible' }));
    expect(d).toEqual({ kind: 'authorized', riskClass: 'internal_reversible' });
  });
});

describe('decideDispatch — the registry (G2, TOOL-001)', () => {
  test('an UNREGISTERED tool is refused before anything else is even consulted', () => {
    // Deliberately permissive everywhere else. If registration were checked late, this would pass authorized.
    const d = decideDispatch(clear({ registered: false }));
    expect(d).toEqual({ kind: 'denied', reason: 'not_registered', riskClass: MOST_RESTRICTIVE_RISK_CLASS });
  });

  test('an unregistered tool reports the MOST RESTRICTIVE class, never the class it claimed', () => {
    // A caller cannot lower its own gate by asserting a class for a tool the registry does not have.
    const d = decideDispatch({ ...clear({ registered: false }), riskClass: 'informational' });
    expect(d.riskClass).toBe(MOST_RESTRICTIVE_RISK_CLASS);
  });

  test('an UNCLASSIFIED registered tool resolves to the most restrictive class and is gated as one', () => {
    // TOOL-001: "unclassified = most restrictive". With no policy engine it must NOT proceed.
    const d = decideDispatch(clear({ riskClass: null, policy: { kind: 'unavailable' }, approval: { kind: 'unavailable' } }));
    expect(d).toEqual({ kind: 'denied', reason: 'policy_unavailable', riskClass: MOST_RESTRICTIVE_RISK_CLASS });
  });
});

describe('decideDispatch — the allowlist (G3, WORK-005, invariant 4)', () => {
  test('a tool absent from the allowlist is refused', () => {
    expect(decideDispatch(clear({ allowlist: ['memory_read'] })).kind).toBe('denied');
    expect(decideDispatch(clear({ allowlist: ['memory_read'] }))).toMatchObject({ reason: 'not_allowlisted' });
  });

  test('NO allowlist at all is refused, and is DISTINGUISHABLE from an empty one', () => {
    // Two different problems with two different fixes: a missing allowlist is a configuration fault, an empty one is
    // a worker that legitimately may use nothing. Collapsing them would hide the first inside the second.
    expect(decideDispatch(clear({ allowlist: undefined }))).toMatchObject({ reason: 'no_allowlist' });
    expect(decideDispatch(clear({ allowlist: [] }))).toMatchObject({ reason: 'not_allowlisted' });
  });

  test('the allowlist is checked AFTER registration — an unregistered tool is never reported as un-allowlisted', () => {
    const d = decideDispatch(clear({ registered: false, allowlist: undefined }));
    expect(d).toMatchObject({ reason: 'not_registered' });
  });
});

describe('decideDispatch — the gates fail CLOSED (G4)', () => {
  test('an emergency stop refuses, whatever policy and approval say', () => {
    expect(decideDispatch(clear({ stop: { kind: 'stopped' } }))).toMatchObject({ reason: 'emergency_stopped' });
  });

  test('an UNREACHABLE stop state refuses too, and says so distinctly', () => {
    // "No stop is recorded" is a complete answer; "I could not check" is not. They must not read the same.
    expect(decideDispatch(clear({ stop: { kind: 'unavailable' } }))).toMatchObject({ reason: 'stop_unavailable' });
  });

  test('a policy DENY refuses, and beats approval (POL-005: approval cannot override forbidden)', () => {
    const d = decideDispatch(clear({ policy: { kind: 'deny' }, approval: { kind: 'allow' } }));
    expect(d).toMatchObject({ reason: 'policy_denied' });
  });

  test('a policy deny is NEVER waived, not even for the least restrictive class', () => {
    const d = decideDispatch(clear({ riskClass: 'informational', policy: { kind: 'deny' } }));
    expect(d).toMatchObject({ reason: 'policy_denied' });
  });

  test('an invalid approval refuses', () => {
    expect(decideDispatch(clear({ approval: { kind: 'deny' } }))).toMatchObject({ reason: 'approval_invalid' });
  });

  test('an approval deny is NEVER waived either', () => {
    const d = decideDispatch(clear({ riskClass: 'informational', approval: { kind: 'deny' } }));
    expect(d).toMatchObject({ reason: 'approval_invalid' });
  });
});

describe('decideDispatch — the Phase 5 envelope (IMPLEMENTATION-ROADMAP §M5)', () => {
  // "P5 execution is gated by user-initiated runs on informational-class tools ONLY."
  const noEngines = { policy: { kind: 'unavailable' }, approval: { kind: 'unavailable' } } as const;

  test('the waiver set is exactly `informational` — the LEAST restrictive class and nothing above it', () => {
    expect([...CLASSES_THAT_PROCEED_WITHOUT_A_GATE]).toEqual(['informational']);
    expect(CLASSES_THAT_PROCEED_WITHOUT_A_GATE).not.toContain(MOST_RESTRICTIVE_RISK_CLASS);
  });

  test('informational proceeds when no engine has answered', () => {
    expect(decideDispatch(clear({ ...noEngines, riskClass: 'informational' }))).toEqual({ kind: 'authorized', riskClass: 'informational' });
  });

  // ── the waiver stands in for a MISSING policy answer, never for a present one (CDR-066 §0; owner ruled option A,
  // 2026-07-29) ───────────────────────────────────────────────────────────────────────────────────────────────
  //
  // THE DEFECT THIS PINS: `GateAnswer` is `allow | deny | unavailable` and cannot express ADR-010's third output,
  // `require_approval`. So an engine requiring approval must answer the policy gate `allow` (it is not a denial) and
  // let the APPROVAL gate carry the requirement. Before this fix the waiver applied to the approval gate too, so an
  // informational call on a trusted path was authorized with no approval — the AI acting without the human okay that
  // policy had just demanded. Reachable because `require_approval` is not risk-class-derived: a spend cap (POL-001)
  // or usage limit (NFR-015) requires approval for an ordinary research run.
  test('an ENGINE-ALLOWED informational call still needs an approval answer — the waiver does not cover it', () => {
    const d = decideDispatch(clear({ riskClass: 'informational', policy: { kind: 'allow' }, approval: { kind: 'unavailable' } }));
    expect(d).toEqual({ kind: 'denied', reason: 'approval_required', riskClass: 'informational' });
  });

  test('the waiver survives exactly where it was meant to: policy unavailable AND approval unavailable', () => {
    expect(decideDispatch(clear({ ...noEngines, riskClass: 'informational' }))).toEqual({ kind: 'authorized', riskClass: 'informational' });
  });

  // ── INV-2: the SINGLE-READ property (CDR-066 §0.2) ────────────────────────────────────────────────────
  //
  // CDR-066 recorded INV-2 as "not covered by any test, because it is a property of the code's SHAPE rather than
  // its behaviour". That was wrong, and this is the correction: read COUNT is observable from the outside, so the
  // property is behavioural after all. A getter that counts reads asserts it directly.
  //
  // Why it matters: the unreachability proof for `approval_required` depends on `policy` being one const from ONE
  // read. If anyone re-evaluates `gate(facts.policy)` near the approval check, a lazy or hostile `facts` object can
  // make the two reads disagree, and the branch that was proven unreachable becomes reachable again.
  test('INV-2: `facts.policy` is read EXACTLY once, so two reads can never disagree', () => {
    // THE FIXTURE HAS TO REACH THE APPROVAL LINE, and the first version of this test did not — found by mutation.
    // With an `informational` class and no engine, `waived` is true, so `!waived` short-circuits before any second
    // read could happen and a re-reading implementation passed the test unnoticed. A NON-waivable class with policy
    // ALLOWING and approval ABSENT is the state that actually gets there.
    let reads = 0;
    const facts = {
      ...clear({ riskClass: 'external_reversible', approval: { kind: 'unavailable' } }),
      get policy() {
        reads += 1;
        // Flips after the first read: a second read would see a DIFFERENT answer, which is precisely the disagreement
        // the unreachability proof cannot survive.
        return reads === 1 ? ({ kind: 'allow' } as const) : ({ kind: 'unavailable' } as const);
      },
    };
    const decision = decideDispatch(facts);
    expect(reads).toBe(1);
    // …and the decision is the one the single read implies.
    expect(decision).toMatchObject({ kind: 'denied', reason: 'approval_required' });
  });

  test('INV-2: `facts.untrustedContext` is read EXACTLY once too — `waived` depends on it', () => {
    let reads = 0;
    const facts = {
      ...clear({ ...noEngines, riskClass: 'informational' }),
      get untrustedContext() {
        reads += 1;
        return reads !== 1;
      },
    };
    decideDispatch(facts);
    expect(reads).toBe(1);
  });

  test('INV-4: `gate()` is total onto the three kinds — no fourth value can escape it', () => {
    // The exhaustive case split in the proof needs this. Anything unrecognised must land on `unavailable`, which is
    // the refusing value; a fourth escape hatch would break the split and could carry an unchecked answer through.
    for (const hostile of [{ kind: 'ALLOW' }, { kind: new String('allow') }, { kind: 4 }, { kind: null }, {}, null, undefined, 'allow']) {
      const d = decideDispatch(clear({ riskClass: 'external_reversible', policy: hostile as never, approval: { kind: 'allow' } }));
      // Not `allow`, therefore treated as unavailable → refused for a non-waivable class.
      expect(d).toMatchObject({ kind: 'denied', reason: 'policy_unavailable' });
    }
  });

  test('EVERY class above informational is refused when no engine has answered', () => {
    for (const riskClass of RISK_CLASSES.filter((c) => c !== 'informational')) {
      const d = decideDispatch(clear({ ...noEngines, riskClass }));
      expect(d).toEqual({ kind: 'denied', reason: 'policy_unavailable', riskClass });
    }
  });

  test('an absent APPROVAL alone still refuses a gated class, even with policy allowing', () => {
    const d = decideDispatch(clear({ riskClass: 'external_reversible', policy: { kind: 'allow' }, approval: { kind: 'unavailable' } }));
    expect(d).toMatchObject({ reason: 'approval_required' });
  });

  test('the waiver does NOT extend to the stop state — a stop still refuses an informational call', () => {
    const d = decideDispatch(clear({ ...noEngines, riskClass: 'informational', stop: { kind: 'stopped' } }));
    expect(d).toMatchObject({ reason: 'emergency_stopped' });
  });

  test('the waiver does NOT extend to registration or the allowlist', () => {
    expect(decideDispatch(clear({ ...noEngines, registered: false }))).toMatchObject({ reason: 'not_registered' });
    expect(decideDispatch(clear({ ...noEngines, allowlist: [] }))).toMatchObject({ reason: 'not_allowlisted' });
  });
});

describe('decideDispatch — the injection boundary (P5-003c; NFR-021; invariant 17)', () => {
  // "Heightened policy scrutiny on any tool call proposed while processing untrusted content." Heightened can only
  // mean MORE refusal, so the informational waiver is withdrawn — and in Phase 5 there is no engine to replace it.
  test('untrusted context WITHDRAWS the informational waiver — and says so with its own reason', () => {
    const noEngines = { policy: { kind: 'unavailable' }, approval: { kind: 'unavailable' } } as const;
    expect(decideDispatch(clear({ ...noEngines, riskClass: 'informational' })).kind).toBe('authorized');
    const under = decideDispatch(clear({ ...noEngines, riskClass: 'informational', untrustedContext: true }));
    expect(under).toEqual({ kind: 'denied', reason: 'untrusted_context', riskClass: 'informational' });
  });

  test('a class that was already refused keeps its OWN reason — untrusted context is not a blanket relabel', () => {
    // `policy_unavailable` is why an internal_reversible call fails; the untrusted context changed nothing for it.
    const d = decideDispatch(clear({ riskClass: 'internal_reversible', policy: { kind: 'unavailable' }, approval: { kind: 'unavailable' }, untrustedContext: true }));
    expect(d).toMatchObject({ reason: 'policy_unavailable' });
  });

  test('an explicit policy ALLOW still authorizes under untrusted context — this withdraws a waiver, not permission', () => {
    // Phase 6's engine is what supplies the heightened scrutiny; the waiver only ever stood in for a missing answer.
    const d = decideDispatch(clear({ riskClass: 'informational', untrustedContext: true, policy: { kind: 'allow' }, approval: { kind: 'allow' } }));
    expect(d.kind).toBe('authorized');
  });

  test('untrusted context does not override the EARLIER gates — they still report their own reasons', () => {
    expect(decideDispatch(clear({ untrustedContext: true, registered: false }))).toMatchObject({ reason: 'not_registered' });
    expect(decideDispatch(clear({ untrustedContext: true, allowlist: [] }))).toMatchObject({ reason: 'not_allowlisted' });
    expect(decideDispatch(clear({ untrustedContext: true, stop: { kind: 'stopped' } }))).toMatchObject({ reason: 'emergency_stopped' });
  });

  test('an absent flag is the trusted path — the boundary is opt-IN by the caller that knows its provenance', () => {
    const noEngines = { policy: { kind: 'unavailable' }, approval: { kind: 'unavailable' } } as const;
    expect(decideDispatch(clear({ ...noEngines, riskClass: 'informational' })).kind).toBe('authorized');
  });
});

describe('decideDispatch — total and deny-by-default', () => {
  test('a malformed gate answer is treated as no answer, not as permission', () => {
    const forged = { kind: 'ALLOW' } as unknown as DispatchRequestFacts['policy'];
    const d = decideDispatch(clear({ riskClass: 'internal_reversible', policy: forged }));
    expect(d).toMatchObject({ reason: 'policy_unavailable' });
  });

  test('a malformed STOP answer refuses rather than reading as clear', () => {
    const forged = { kind: 'fine' } as unknown as DispatchRequestFacts['stop'];
    expect(decideDispatch(clear({ stop: forged }))).toMatchObject({ reason: 'stop_unavailable' });
  });

  test('every returned reason is a member of the closed set', () => {
    const broken: DispatchRequestFacts[] = [
      clear({ registered: false }),
      clear({ allowlist: undefined }),
      clear({ allowlist: [] }),
      clear({ stop: { kind: 'stopped' } }),
      clear({ stop: { kind: 'unavailable' } }),
      clear({ policy: { kind: 'deny' } }),
      clear({ riskClass: 'sensitive_irreversible', policy: { kind: 'unavailable' } }),
      clear({ approval: { kind: 'deny' } }),
      clear({ riskClass: 'sensitive_irreversible', approval: { kind: 'unavailable' } }),
    ];
    for (const facts of broken) {
      const d = decideDispatch(facts);
      expect(d.kind).toBe('denied');
      if (d.kind === 'denied') expect(isToolDenialReason(d.reason)).toBe(true);
    }
  });
});
