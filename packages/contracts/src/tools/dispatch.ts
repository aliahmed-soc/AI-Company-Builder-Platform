// @acbp/contracts — the tool-dispatch decision (ACBP-P5-003b; CDR-054; TOOL-002/003; WORK-005; ADR-012;
// trust-critical #4). Zero-dep and PURE: this module decides, it never executes and never reads a database.
//
// THIS IS THE GATE. Diagram `07-worker-execution` fixes the order — allowlist, then stop-state + policy + approval,
// then "fail closed + audited" — and `COMPONENT-CATALOG` names the component *"Trusted — the enforcement chokepoint"*
// with the failure mode *"Fail closed on any gate outage"*. Everything below follows from those two sentences.
//
// The decision is kept PURE and separate from `dispatchToolCall` for one reason: a gate that can only be exercised
// through a database is a gate that is mostly untested. Here every combination is a function call.
import { resolveRiskClass, MOST_RESTRICTIVE_RISK_CLASS, type RiskClass } from './risk-class.js';
import type { AutonomousWorkDecision } from '../company/lifecycle-gate.js';

/**
 * CLOSED. TOOL-002.
 *
 * `requested` exists because the record is written BEFORE execution (CDR-054 §1-G5): a record written afterwards
 * cannot exist for a call that died mid-flight, which is precisely the call worth having a record of.
 *
 * `unconfirmed` is canon's own word and its own failure clause — *"Missing receipt marks the call outcome
 * 'unconfirmed', never 'succeeded'."* An external effect we cannot evidence is not a success, and giving it a
 * separate outcome is what stops it from being reported as one.
 */
export const TOOL_CALL_OUTCOMES = ['requested', 'denied', 'succeeded', 'failed', 'unconfirmed'] as const;
export type ToolCallOutcome = (typeof TOOL_CALL_OUTCOMES)[number];

/**
 * CLOSED. Why a call was refused — a REASON, never provider or engine exception text.
 *
 * Each pair below is deliberately two values rather than one, because they have different fixes:
 *   `no_allowlist` / `not_allowlisted`   — a configuration fault vs. a worker legitimately not permitted this tool.
 *   `policy_unavailable` / `policy_denied` — TOOL-003 gives unavailability its own consequence ("blocks execution
 *                                            (fail closed), with owner notification"), so it needs its own reason.
 *   `stop_unavailable` / `emergency_stopped` — "no stop is recorded" is a complete answer; "I could not check" is not.
 *   `approval_required` / `approval_invalid` — nobody could confirm an approval vs. the one presented was rejected.
 */
export const TOOL_DENIAL_REASONS = [
  'not_registered',
  'no_allowlist',
  'not_allowlisted',
  'emergency_stopped',
  'stop_unavailable',
  'policy_denied',
  'policy_unavailable',
  'approval_invalid',
  'approval_required',
  // ACBP-P5-003c: the ONLY thing that refused this call was the untrusted provenance of the working context.
  // Distinct from `policy_unavailable` on purpose - it names a call that WOULD have proceeded on the trusted path.
  'untrusted_context',
  // ACBP-P7-002 (CDR-079; launch Gate 14): the company was not in a state permitting autonomous work.
  //
  // ONE VALUE, NOT FOUR. The gate distinguishes account-vs-company and not-active-vs-unreadable, and those four
  // reasons reach the LOG, where an operator diagnoses. They are not four denial reasons, because every one of
  // them sends a reader to the same place - the company's lifecycle state. That is the test `stop_unavailable`
  // and `emergency_stopped` pass and these fail: those two are separate values precisely because one sends a
  // reader to look for a broken engine and the other to a stop somebody activated.
  //
  // MUST NOT REUSE `emergency_stopped`. That value is persisted, re-validated on read, and additionally drives
  // the held-work + `running`->`paused` block, so reusing it would misattribute the refusal and send an operator
  // hunting a stop row that does not exist.
  'company_not_active',
] as const;
export type ToolDenialReason = (typeof TOOL_DENIAL_REASONS)[number];

export function isToolCallOutcome(value: unknown): value is ToolCallOutcome {
  return typeof value === 'string' && (TOOL_CALL_OUTCOMES as readonly string[]).includes(value);
}
export function isToolDenialReason(value: unknown): value is ToolDenialReason {
  return typeof value === 'string' && (TOOL_DENIAL_REASONS as readonly string[]).includes(value);
}

/**
 * What a gate said. `unavailable` is NOT an error — it is the honest statement that no engine answered, which in
 * Phase 5 is the normal case because the engine does not exist yet (P6 builds it).
 */
export type GateAnswer = { readonly kind: 'allow' } | { readonly kind: 'deny' } | { readonly kind: 'unavailable' };

/**
 * What the POLICY engine said. ADR-010's three outputs plus `unavailable` (ACBP-P6-002; CDR-067 §2-G7).
 *
 * `require_approval` lives HERE, on the policy answer, and NOT as a separate `approvalRequired` boolean on the facts.
 * That is the whole design, not a stylistic choice: **there is no separate fact for a caller to supply or forge.**
 * The requirement is inseparable from the answer that produced it, and the dispatcher derives that answer from the
 * engine internally — `ToolGates` has no `policy` port to inject through. A gate a caller may omit will eventually be
 * omitted; a fact a caller may forge will eventually be forged. Neither is expressible here.
 *
 * Before this, the dispatcher demanded an approval answer for every non-waived call, which made `allow` and
 * `require_approval` indistinguishable at the gate — ADR-010's middle output carried no meaning, and its `allow`
 * output carried none either.
 */
export type PolicyGateAnswer = GateAnswer | { readonly kind: 'require_approval' };

/**
 * The emergency-stop state (`DATA-ARCHITECTURE`: *"checked by dispatcher"*).
 *
 * `clear` is a real answer, distinct from `unavailable`: in Phase 5 there is no stop mechanism at all, so no stop CAN
 * be in force and `clear` is simply true. That is not the same as a stop store we failed to reach, which tells us
 * nothing and therefore refuses.
 */
export type StopAnswer = { readonly kind: 'clear' } | { readonly kind: 'stopped' } | { readonly kind: 'unavailable' };

export interface DispatchRequestFacts {
  readonly toolId: string;
  /** Is this tool in `tool_definitions`? TOOL-001: *"Unknown tools cannot be invoked."* */
  readonly registered: boolean;
  /** The registry's stored class. `unknown` on purpose — it comes from a nullable column and is resolved here. */
  readonly riskClass: unknown;
  /** The worker's tool allowlist. `undefined` means NONE WAS SUPPLIED, which is not the same as an empty one. */
  readonly allowlist: readonly string[] | undefined;
  readonly stop: StopAnswer;
  /** The policy engine's answer, which also carries WHETHER an approval is required. See {@link PolicyGateAnswer}. */
  readonly policy: PolicyGateAnswer;
  readonly approval: GateAnswer;
  /**
   * Was this call proposed while UNTRUSTED content was in the working context? (ACBP-P5-003c; NFR-021.)
   *
   * `AI-AND-WORKER-ARCHITECTURE §4` requires *heightened policy scrutiny* here, and heightened can only mean MORE
   * refusal — so it WITHDRAWS the Phase 5 waiver below. It does not withdraw permission: an engine that explicitly
   * allows is still obeyed, because the waiver only ever stood in for a missing answer.
   */
  readonly untrustedContext?: boolean;
  /**
   * May this company do autonomous work at all? (ACBP-P7-002; CDR-079; launch **Gate 14**.)
   *
   * REQUIRED, NOT OPTIONAL, and that is the whole point of adding it here rather than checking it at the call
   * site. An optional field defaulting to permitted is the shape CDR-075 §4.3 had to disclose about the caps
   * seam and CDR-079 §1 found again in `canPickUpAutonomousWork`: a control that is configured, documented and
   * inert. Making it required means the compiler names every caller that has not answered it.
   *
   * It is a DECISION, not a status: the caller reads both lifecycle rows under a lock and passes the verdict, so
   * this type never has to know what a company status is.
   */
  readonly lifecycle: AutonomousWorkDecision;
}

export type DispatchDecision =
  | { readonly kind: 'authorized'; readonly riskClass: RiskClass }
  | { readonly kind: 'denied'; readonly reason: ToolDenialReason; readonly riskClass: RiskClass };

/**
 * The classes that may proceed when NO policy engine has answered.
 *
 * `IMPLEMENTATION-ROADMAP-v1 §M5`, verbatim: *"P5 execution is gated by user-initiated runs on informational-class
 * tools only."* That sentence is the whole justification for this constant, and it is why the constant is a set of
 * classes rather than a boolean — it names exactly what canon names.
 *
 * IT WAIVES ONLY `unavailable`, NEVER `deny`. An engine that explicitly refuses is obeyed for every class including
 * this one. And it waives nothing else: registration, the allowlist and the stop state are checked regardless.
 *
 * P6 makes this dead weight rather than dangerous — once a real engine answers `allow`/`deny`, the waiver branch is
 * unreachable. It is deliberately NOT a config value: a knob here would be a knob that turns the chokepoint off.
 */
export const CLASSES_THAT_PROCEED_WITHOUT_A_GATE: readonly RiskClass[] = ['informational'];

function policyGate(answer: unknown): PolicyGateAnswer['kind'] {
  const kind = (answer as { kind?: unknown } | undefined)?.kind;
  // Same deny-by-default rule as gate, widened by exactly one recognised value. Anything unrecognised is 'no
  // answer', because treating an unreadable value as permission is the one mistake this module must never make.
  return kind === 'allow' || kind === 'deny' || kind === 'require_approval' ? kind : 'unavailable';
}

function gate(answer: unknown): GateAnswer['kind'] {
  const kind = (answer as { kind?: unknown } | undefined)?.kind;
  // Anything we do not recognise is "no answer". Treating an unrecognised value as `allow` is the one mistake this
  // module must never make, so the fallback is the refusing one.
  return kind === 'allow' || kind === 'deny' ? kind : 'unavailable';
}

/**
 * Decide whether a proposed tool call may execute.
 *
 * TOTAL and deny-by-default: every input shape produces a decision, and every unrecognised input produces a REFUSAL.
 * The order is canon's (diagram 07) and each step's position is load-bearing — checking the allowlist before
 * registration, for instance, would report a tool that does not exist as one the worker is not permitted, sending
 * whoever reads the record to fix the wrong thing.
 */
export function decideDispatch(facts: DispatchRequestFacts): DispatchDecision {
  // An unregistered tool has no trustworthy class: the one the caller supplied describes a tool the registry does not
  // have, so honouring it would let a caller lower its own gate by asserting a class for a tool nobody registered.
  if (!facts.registered) return { kind: 'denied', reason: 'not_registered', riskClass: MOST_RESTRICTIVE_RISK_CLASS };

  // Resolved ONCE, here. Unclassified resolves to the most restrictive class (TOOL-001), so the unclassified case
  // needs no rule of its own anywhere below — it is simply gated like the most dangerous class there is.
  const riskClass = resolveRiskClass(facts.riskClass);
  const deny = (reason: ToolDenialReason): DispatchDecision => ({ kind: 'denied', reason, riskClass });

  // LIFECYCLE FIRST, before any question about WHICH tool (ACBP-P7-002; CDR-079). A company that may not act at
  // all does not get asked whether this particular tool is allowlisted — the broadest refusal is the truest one,
  // and answering `not_allowlisted` to a paused company would send an operator to edit a worker's allowlist.
  //
  // It sits after `not_registered` only because that branch resolves the risk class every later denial carries.
  //
  // The `!== true` form is deliberate: `AutonomousWorkDecision` is a discriminated union, but this is a trust
  // boundary and the value arrives from a caller — anything that is not an explicit `allowed: true` refuses.
  if (facts.lifecycle?.allowed !== true) return deny('company_not_active');

  if (facts.allowlist === undefined) return deny('no_allowlist');
  if (!facts.allowlist.includes(facts.toolId)) return deny('not_allowlisted');

  const stop = (facts.stop as { kind?: unknown } | undefined)?.kind;
  if (stop === 'stopped') return deny('emergency_stopped');
  if (stop !== 'clear') return deny('stop_unavailable');

  // Policy before approval: POL-005 — "approval cannot override forbidden".
  const policy = policyGate(facts.policy);

  // The waiver exists ONLY to stand in for a MISSING policy answer on the trusted path. Two things withdraw it:
  //
  //   1. Untrusted provenance — canon's trigger for heightened scrutiny (P5-003c, NFR-021).
  //   2. A policy engine having ANSWERED AT ALL (owner ruling, CDR-066 §0 option A, 2026-07-29).
  //
  // (2) closes a real bypass. `GateAnswer` is `allow | deny | unavailable` and cannot express ADR-010's third output,
  // `require_approval`; an engine requiring approval must therefore answer this gate `allow` — it is not a denial —
  // and let the APPROVAL gate below carry the requirement. While the waiver also covered that gate, an informational
  // call on a trusted path was AUTHORIZED with no approval, i.e. the AI acting without the human okay policy had just
  // demanded. It is reachable because `require_approval` is not risk-class-derived: a spend cap (POL-001) or usage
  // limit (NFR-015) requires approval for an ordinary research run.
  // ONE READ, ONE CONST — INV-2 applies to this fact exactly as it does to `policy`, and for the same reason: it is
  // consulted twice below (the waiver, and the approval requirement), so a second read could make those two
  // conclusions disagree about the same call. Adding the requirement clause introduced precisely that second read,
  // and the INV-2 test failed on it with `expected 2 to be 1` before this const existed.
  const untrusted = facts.untrustedContext === true;
  const waivable = CLASSES_THAT_PROCEED_WITHOUT_A_GATE.includes(riskClass);
  const waived = waivable && !untrusted && policy === 'unavailable';
  // When the untrusted context is the ONLY reason a call fails, say so: policy_unavailable would send a reader to
  // look for a broken engine, when what actually happened is the boundary doing its job.
  const gateless = (): ToolDenialReason => (waivable ? 'untrusted_context' : 'policy_unavailable');

  if (policy === 'deny') return deny('policy_denied');
  if (policy === 'unavailable' && !waived) return deny(gateless());

  // POLICY IS THE AUTHORITY ON WHETHER AN APPROVAL IS NEEDED (ACBP-P6-002; CDR-067 §2-G7; PM ruling 2026-07-29).
  //
  // Derived from the policy answer, on the same `policy` const INV-2 pins — NOT a fact a caller can supply. There is
  // no `approvalRequired` input anywhere, so there is nothing to forge: the requirement is inseparable from the
  // answer that produced it, and the dispatcher builds that answer from the engine (`ToolGates` has no policy port).
  //
  // …OR UNTRUSTED PROVENANCE DEMANDS ONE (CDR-067 §2-G9). This second clause is not defensive padding; it closes a
  // hole the first clause opened. Before P6-002, untrusted content refused a call by WITHDRAWING the waiver, which
  // worked only because an approval was demanded of every non-waived call. Once the demand became conditional on
  // policy, an `allow` answer meant `untrustedContext` had no effect whatsoever and the NFR-021 boundary went dead —
  // laundered content would have reached tools on a plain `allow`. Caught by the injection corpus, not by review.
  //
  // `AI-AND-WORKER-ARCHITECTURE §4` requires *heightened policy scrutiny* on a call proposed while processing
  // untrusted content, and heightened can only mean MORE refusal — so untrusted provenance REQUIRES an approval in
  // its own right. It cannot grant one: an explicit `deny` from either gate still refuses below.
  // `untrusted` is the SINGLE const read above, beside `policy`, and for the same INV-2 reason.
  const approvalRequired = policy === 'require_approval' || untrusted;

  const approval = gate(facts.approval);
  // AN EXPLICIT REFUSAL ALWAYS WINS, whether or not policy asked for an approval. "No approval was needed" is not a
  // licence to ignore one that says no — that is how a revocation would get lost.
  if (approval === 'deny') return deny('approval_invalid');
  // AN ABSENT APPROVAL REFUSES ONLY WHEN POLICY DEMANDED ONE.
  //
  // `approvalRequired` is the whole condition now, and `!waived` is gone from this line deliberately: EITHER disjunct
  // already forces `waived` false. `policy === 'require_approval'` is an ANSWER, so INV-3's `policy === 'unavailable'`
  // conjunct fails; and `untrusted` is itself one of `waived`'s conjuncts, negated. Keeping `!waived` would have been
  // dead weight that reads like a second guard, and a guard that cannot fire is worse than no guard: the next reader
  // trusts it. (This is the one place the two clauses of `approvalRequired` had to be checked SEPARATELY — a proof
  // that held for the policy disjunct alone would not have held for the union.)
  //
  // `approval_required` remains the honest reason, and `untrusted_context` remains wrong here for the reason CDR-066
  // §0.1 established: that reason means "would have proceeded on the trusted path", and a call whose policy demands
  // approval is refused identically on the trusted path.
  //
  // THE INVARIANTS THIS STILL DEPENDS ON — CDR-066 §0.2 records why each matters:
  //   INV-1  the `policy === 'deny'` and `policy === 'unavailable' && !waived` checks stay ABOVE this one;
  //   INV-2  `policy` stays ONE const from ONE read of `facts.policy` — `approvalRequired` is derived from THAT const,
  //          so a second read could make the requirement disagree with the answer that produced it. DIRECTLY TESTED
  //          by the read-counting getter in `dispatch.test.ts`, which fails on a second read even when that read
  //          changes no decision at all;
  //   INV-3  `waived` keeps `policy === 'unavailable'` as a conjunct — that conjunct IS the CDR-066 §0 bypass fix,
  //          and it is now also what makes `!waived` unnecessary on this line;
  //   INV-4  `policyGate()` stays total onto its four kinds with `unavailable` as the fallback. It gained exactly one
  //          recognised value; anything unrecognised must still land on `unavailable`, or an unreadable answer could
  //          be read as `require_approval` — or worse, as `allow`.
  //
  // THE REASON DISTINGUISHES WHY the approval was required, and the distinction is the one CDR-066 §0.1 established:
  // `untrusted_context` means *"this would have proceeded on the trusted path"*. That is true only when untrusted
  // provenance was the SOLE cause — if policy demanded the approval too, the call would have been held on the
  // trusted path as well, and blaming provenance would send a reader to quarantine content that was never the
  // problem.
  if (approval === 'unavailable' && approvalRequired) return deny(untrusted && policy !== 'require_approval' ? 'untrusted_context' : 'approval_required');

  return { kind: 'authorized', riskClass };
}
