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
  readonly policy: GateAnswer;
  readonly approval: GateAnswer;
  /**
   * Was this call proposed while UNTRUSTED content was in the working context? (ACBP-P5-003c; NFR-021.)
   *
   * `AI-AND-WORKER-ARCHITECTURE §4` requires *heightened policy scrutiny* here, and heightened can only mean MORE
   * refusal — so it WITHDRAWS the Phase 5 waiver below. It does not withdraw permission: an engine that explicitly
   * allows is still obeyed, because the waiver only ever stood in for a missing answer.
   */
  readonly untrustedContext?: boolean;
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

  if (facts.allowlist === undefined) return deny('no_allowlist');
  if (!facts.allowlist.includes(facts.toolId)) return deny('not_allowlisted');

  const stop = (facts.stop as { kind?: unknown } | undefined)?.kind;
  if (stop === 'stopped') return deny('emergency_stopped');
  if (stop !== 'clear') return deny('stop_unavailable');

  // Policy before approval: POL-005 — "approval cannot override forbidden".
  const policy = gate(facts.policy);

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
  const waivable = CLASSES_THAT_PROCEED_WITHOUT_A_GATE.includes(riskClass);
  const waived = waivable && facts.untrustedContext !== true && policy === 'unavailable';
  // When the untrusted context is the ONLY reason a call fails, say so: policy_unavailable would send a reader to
  // look for a broken engine, when what actually happened is the boundary doing its job.
  const gateless = (): ToolDenialReason => (waivable ? 'untrusted_context' : 'policy_unavailable');

  if (policy === 'deny') return deny('policy_denied');
  if (policy === 'unavailable' && !waived) return deny(gateless());

  const approval = gate(facts.approval);
  if (approval === 'deny') return deny('approval_invalid');
  // ALWAYS `approval_required` here, and that is now provable rather than a simplification: reaching this line means
  // policy did not deny and was not an unwaived `unavailable`, and a waived call cannot get here at all — so policy
  // answered `allow`. Untrusted provenance can no longer be the cause, because with policy answered the waiver was
  // never in play; the honest reason is simply that an approval is required and none was presented.
  if (approval === 'unavailable' && !waived) return deny('approval_required');

  return { kind: 'authorized', riskClass };
}
