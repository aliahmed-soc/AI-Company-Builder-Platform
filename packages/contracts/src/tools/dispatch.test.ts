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
  // SUPERSEDED BY THE TYPE, and that is the better fix (ACBP-P6-002; CDR-067 §2-G7).
  //
  // This test used to be the CDR-066 §0 bypass proof: policy `allow` + approval `unavailable` + informational +
  // trusted had to DENY, because an engine requiring approval could only answer `allow` and the waiver then swallowed
  // the approval demand. The root cause was that `GateAnswer` could not express `require_approval`.
  //
  // It can now. An engine requiring approval says so, so the flattening that created the bypass cannot happen, and
  // policy `allow` genuinely means "no approval needed" — authorizing is correct, not a regression. The equivalent
  // assertion under the new model is the `require_approval` case below, which denies for EVERY class including the
  // waivable one. Keeping this test as written would have pinned the old workaround in place forever.
  test('policy ALLOW on an informational call authorizes — `allow` now means what it says', () => {
    const d = decideDispatch(clear({ riskClass: 'informational', policy: { kind: 'allow' }, approval: { kind: 'unavailable' } }));
    expect(d).toEqual({ kind: 'authorized', riskClass: 'informational' });
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
        // `require_approval` FIRST, because that is now what reaches the approval line (CDR-067 §2-G7) — and it is
        // also the read `approvalRequired` is derived from. Flips after: a second read would see a different answer,
        // so the REQUIREMENT could disagree with the answer that produced it.
        return reads === 1 ? ({ kind: 'require_approval' } as const) : ({ kind: 'allow' } as const);
      },
    };
    const decision = decideDispatch(facts);
    expect(reads).toBe(1);
    // …and the decision is the one the single read implies.
    expect(decision).toMatchObject({ kind: 'denied', reason: 'approval_required' });
  });

  test('INV-2: `facts.untrustedContext` is read EXACTLY once on the WAIVER path', () => {
    let reads = 0;
    const facts = {
      ...clear({ ...noEngines, riskClass: 'informational' }),
      get untrustedContext() {
        reads += 1;
        return reads !== 1;
      },
    };
    const decision = decideDispatch(facts);
    expect(reads).toBe(1);
    // Trusted on the only read, so the waiver applies — a second read seeing `true` would have refused instead.
    expect(decision).toMatchObject({ kind: 'authorized' });
  });

  test('INV-2: …and exactly once on the path that reaches the REASON, which the waiver case never touches', () => {
    // REVIEW PASS 2 FOUND THIS HOLE IN THE TEST ABOVE. That fixture authorizes, so `approvalRequired` is false and
    // the third read site — the ternary that picks `untrusted_context` over `approval_required` — is never evaluated.
    // A re-read introduced THERE would not have moved the counter. This fixture reaches it: policy ALLOWS (so the
    // waiver cannot apply), provenance is untrusted (so an approval is required), and none is offered.
    let reads = 0;
    const facts = {
      ...clear({ riskClass: 'informational', policy: { kind: 'allow' }, approval: { kind: 'unavailable' } }),
      get untrustedContext() {
        reads += 1;
        return reads === 1;
      },
    };
    const decision = decideDispatch(facts);
    expect(reads).toBe(1);
    // A second read returning `false` would have reported `approval_required` — blaming a missing approval for what
    // was actually the content boundary doing its job.
    expect(decision).toMatchObject({ kind: 'denied', reason: 'untrusted_context' });
  });

  /**
   * The hostile shapes both totality tests use. `new String('allow')` is the interesting one: it is an object, not a
   * primitive, so `=== 'allow'` is false and it must NOT be read as an allow.
   */
  const HOSTILE_ANSWERS = [{ kind: 'ALLOW' }, { kind: new String('allow') }, { kind: 4 }, { kind: null }, {}, null, undefined, 'allow', { kind: 'allow ' }, true];

  test('INV-4: `policyGate()` is total onto its FOUR kinds — no fifth value can escape it', () => {
    // Renamed after review pass 2, which caught that this test's title named `gate()` while its body fed
    // `facts.policy`, i.e. `policyGate()`. The names matter here: the two functions have different codomains (three
    // kinds vs four), so a test that claims one and exercises the other leaves the claimed one untested — which is
    // exactly what had happened, see the companion test below.
    for (const hostile of HOSTILE_ANSWERS) {
      const d = decideDispatch(clear({ riskClass: 'external_reversible', policy: hostile as never, approval: { kind: 'allow' } }));
      // Not `allow`, therefore treated as unavailable → refused for a non-waivable class.
      expect(d).toMatchObject({ kind: 'denied', reason: 'policy_unavailable' });
    }
  });

  test('INV-4: `gate()` is total onto the THREE kinds — a malformed APPROVAL never satisfies a policy demand', () => {
    // THE GAP REVIEW PASS 2 FOUND, and it is the one that matters most after this ticket's loosening: the approval
    // gate is now the sole enforcement of `require_approval`, so if `gate()` ever read an unrecognised answer as
    // `allow`, a malformed approval would satisfy an approval that policy DEMANDED. Nothing tested that.
    for (const hostile of HOSTILE_ANSWERS) {
      const d = decideDispatch(clear({ riskClass: 'informational', policy: { kind: 'require_approval' }, approval: hostile as never }));
      expect(d).toMatchObject({ kind: 'denied', reason: 'approval_required' });
    }
  });

  test('INV-4: a malformed approval cannot rescue a call the untrusted boundary demanded one for either', () => {
    for (const hostile of HOSTILE_ANSWERS) {
      const d = decideDispatch(clear({ riskClass: 'informational', policy: { kind: 'allow' }, approval: hostile as never, untrustedContext: true }));
      expect(d).toMatchObject({ kind: 'denied', reason: 'untrusted_context' });
    }
  });

  test('EVERY class above informational is refused when no engine has answered', () => {
    for (const riskClass of RISK_CLASSES.filter((c) => c !== 'informational')) {
      const d = decideDispatch(clear({ ...noEngines, riskClass }));
      expect(d).toEqual({ kind: 'denied', reason: 'policy_unavailable', riskClass });
    }
  });

  // ── POLICY IS THE AUTHORITY ON WHETHER APPROVAL IS NEEDED (ACBP-P6-002; CDR-067 §2-G7; PM ruling) ──────
  //
  // ADR-010's engine output is `allow | require_approval | deny`. Before this, the dispatcher demanded an approval
  // answer for every non-waived call, which made `allow` indistinguishable from `require_approval` — the engine's
  // middle output carried no meaning at the gate. Now the POLICY ANSWER ITSELF says whether an approval is required,
  // so there is no separate boolean anywhere for a caller to supply or forge.
  //
  // THIS TEST REPLACED ONE THAT ENCODED THE OLD SEMANTICS. It used to read "an absent APPROVAL alone still refuses a
  // gated class, EVEN WITH POLICY ALLOWING" and asserted `approval_required`. That expectation was the old stand-in
  // for a missing engine; with a real engine it would refuse actions the company's own policy permitted.
  test('policy REQUIRE_APPROVAL with no approval answer refuses — the demand is never skipped', () => {
    const d = decideDispatch(clear({ riskClass: 'external_reversible', policy: { kind: 'require_approval' }, approval: { kind: 'unavailable' } }));
    expect(d).toEqual({ kind: 'denied', reason: 'approval_required', riskClass: 'external_reversible' });
  });

  test('policy REQUIRE_APPROVAL with an approval ALLOW proceeds — that is what an approval is for', () => {
    const d = decideDispatch(clear({ riskClass: 'external_reversible', policy: { kind: 'require_approval' }, approval: { kind: 'allow' } }));
    expect(d).toEqual({ kind: 'authorized', riskClass: 'external_reversible' });
  });

  test('policy REQUIRE_APPROVAL is never waived, not even for the least restrictive class', () => {
    // The waiver stands in for a MISSING answer. `require_approval` is an answer, and a demanding one.
    const d = decideDispatch(clear({ riskClass: 'informational', policy: { kind: 'require_approval' }, approval: { kind: 'unavailable' } }));
    expect(d).toMatchObject({ kind: 'denied', reason: 'approval_required' });
  });

  test('policy ALLOW does not spuriously demand an approval — for ANY risk class', () => {
    // THE LOOSENING, stated as a test. A company whose policy explicitly allows an external action has decided that;
    // demanding an approval no policy asked for makes ADR-010's `allow` output meaningless.
    for (const riskClass of RISK_CLASSES) {
      const d = decideDispatch(clear({ riskClass, policy: { kind: 'allow' }, approval: { kind: 'unavailable' } }));
      expect(d).toEqual({ kind: 'authorized', riskClass });
    }
  });

  // ── FORGERY: there is no `approvalRequired` input to forge (CDR-067 §2-G8) ──────────────────────────────
  //
  // The requirement is DERIVED from the policy answer inside the decision, on the same single-read const INV-2 pins.
  //
  // THE COMPILE-TIME HALF IS STRONGER THAN THE RUNTIME HALF, so it comes first. Each `@ts-expect-error` below is a
  // self-verifying assertion: TypeScript fails the build if the very next line STOPS being an error. So if anyone
  // widens the facts to accept a caller-supplied requirement, `pnpm typecheck` breaks — no bespoke checker needed,
  // and nothing to keep in step. The runtime tests after them prove the value would be ignored even if it arrived
  // through an `as` cast; the type is what makes it unwritable in the first place.
  test('FORGERY (compile-time): the facts have no field a caller could use to pre-empt the approval demand', () => {
    const base: DispatchRequestFacts = { ...clear({ riskClass: 'external_reversible', policy: { kind: 'require_approval' }, approval: { kind: 'unavailable' } }) };
    // @ts-expect-error `approvalRequired` is not part of DispatchRequestFacts — it is derived inside the decision.
    void decideDispatch({ ...base, approvalRequired: false });
    // @ts-expect-error nor under an alternative spelling.
    void decideDispatch({ ...base, approval_required: false });
    // @ts-expect-error `waived` is a local, not an input — a caller cannot pre-waive anything.
    void decideDispatch({ ...base, waived: true });
    // @ts-expect-error the policy answer's kinds are CLOSED: no invented kind can smuggle a permissive reading in.
    void decideDispatch({ ...base, policy: { kind: 'approval_not_needed' } });
    expect(decideDispatch(base)).toMatchObject({ kind: 'denied', reason: 'approval_required' });
  });
  test('FORGERY: an extra `approvalRequired: false` property is ignored — the demand still refuses', () => {
    const forged = {
      ...clear({ riskClass: 'external_reversible', policy: { kind: 'require_approval' }, approval: { kind: 'unavailable' } }),
      approvalRequired: false,
      approval_required: false,
      requiresApproval: false,
    } as DispatchRequestFacts;
    expect(decideDispatch(forged)).toEqual({ kind: 'denied', reason: 'approval_required', riskClass: 'external_reversible' });
  });

  test('FORGERY: no extra property can turn a require_approval into an authorization, for any class', () => {
    for (const riskClass of RISK_CLASSES) {
      const forged = {
        ...clear({ riskClass, policy: { kind: 'require_approval' }, approval: { kind: 'unavailable' } }),
        approvalRequired: false,
        waived: true,
        approvalWaived: true,
      } as DispatchRequestFacts;
      expect(decideDispatch(forged)).toMatchObject({ kind: 'denied', reason: 'approval_required' });
    }
  });

  // ── THE HOLE THE LOOSENING OPENED, AND ITS CLOSURE (CDR-067 §2-G9) ──────────────────────────────────────
  //
  // Making the approval demand conditional on policy silently disabled the NFR-021 injection boundary: untrusted
  // provenance used to refuse a call by WITHDRAWING the waiver, which only worked while every non-waived call was
  // asked for an approval. With policy answering `allow`, `untrustedContext` stopped having any effect at all.
  //
  // FOUND BY THE INJECTION CORPUS SUITE, not by reading the diff. These tests exist so it can never come back
  // silently: they fail if untrusted provenance stops requiring an approval in its own right.
  test('UNTRUSTED provenance requires an approval EVEN WHEN policy plainly allows', () => {
    const d = decideDispatch(clear({ riskClass: 'informational', policy: { kind: 'allow' }, approval: { kind: 'unavailable' }, untrustedContext: true }));
    expect(d).toEqual({ kind: 'denied', reason: 'untrusted_context', riskClass: 'informational' });
  });

  test('UNTRUSTED provenance requires an approval for EVERY risk class, policy allowing throughout', () => {
    for (const riskClass of RISK_CLASSES) {
      const d = decideDispatch(clear({ riskClass, policy: { kind: 'allow' }, approval: { kind: 'unavailable' }, untrustedContext: true }));
      expect(d).toMatchObject({ kind: 'denied', reason: 'untrusted_context' });
    }
  });

  test('untrusted provenance does not GRANT anything — an approval still authorizes, and a deny still refuses', () => {
    // Heightened scrutiny means more refusal, never less: with a real approval the call proceeds, exactly as a
    // trusted one would, and an explicit refusal still wins.
    expect(decideDispatch(clear({ policy: { kind: 'allow' }, approval: { kind: 'allow' }, untrustedContext: true })).kind).toBe('authorized');
    expect(decideDispatch(clear({ policy: { kind: 'allow' }, approval: { kind: 'deny' }, untrustedContext: true }))).toMatchObject({ reason: 'approval_invalid' });
  });

  test('when policy ALSO required the approval, the reason blames policy — not the content', () => {
    // `untrusted_context` means "would have proceeded on the trusted path". With policy demanding approval it would
    // NOT have, so naming provenance would send a reader to quarantine content that was never the problem.
    const d = decideDispatch(clear({ riskClass: 'external_reversible', policy: { kind: 'require_approval' }, approval: { kind: 'unavailable' }, untrustedContext: true }));
    expect(d).toMatchObject({ kind: 'denied', reason: 'approval_required' });
  });

  test('an EXPLICIT approval deny still refuses even when policy did not require one', () => {
    // Revocation wins regardless. "No approval was needed" is not a licence to ignore one that says no.
    const d = decideDispatch(clear({ riskClass: 'informational', policy: { kind: 'allow' }, approval: { kind: 'deny' } }));
    expect(d).toMatchObject({ kind: 'denied', reason: 'approval_invalid' });
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
      // POLICY MUST DEMAND the approval for its absence to refuse (CDR-067 §2-G7). With `policy: allow` — which
      // `clear()` supplies — an absent approval is no longer a denial at all, so this entry would have stopped
      // producing a refusal and quietly contributed nothing to a test about refusal reasons.
      clear({ riskClass: 'sensitive_irreversible', policy: { kind: 'require_approval' }, approval: { kind: 'unavailable' } }),
    ];
    for (const facts of broken) {
      const d = decideDispatch(facts);
      expect(d.kind).toBe('denied');
      if (d.kind === 'denied') expect(isToolDenialReason(d.reason)).toBe(true);
    }
  });
});
