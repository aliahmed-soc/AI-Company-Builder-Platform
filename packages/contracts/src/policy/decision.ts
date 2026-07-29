// @acbp/contracts — the policy decision vocabulary and its combination rule (ACBP-P6-001a; CDR-066 §3-G1/G2/G4;
// POL-005; ADR-010). Zero-dep and PURE: this module decides nothing about the world, it only says how decisions
// compose.
//
// THE ORDER IS THE CONTRACT. POL-005's "most restrictive wins" is meaningless without one, so combination is a
// comparison on a declared order rather than a pile of conditionals that can drift apart. `RISK_CLASSES` (CDR-051
// §2-G3) established the same shape for the same reason.
//
// DENY-BY-DEFAULT EVERYWHERE. Every function here is total over `unknown`, and every input it cannot read resolves
// to `deny`. `decideDispatch` states the rule this inherits: treating an unrecognised value as `allow` is the one
// mistake this class of module must never make.

/**
 * CLOSED and ORDERED, least → most restrictive. Exactly ADR-010's three outputs.
 *
 * `deny(escalate?)` is ONE decision with a flag, not two: escalation changes who gets told, never whether the action
 * happens. A fourth member would make every consumer's exhaustive switch treat "denied loudly" as a different
 * outcome from "denied", and sooner or later one of those branches would forget to stop the action.
 */
export const POLICY_DECISIONS = ['allow', 'require_approval', 'deny'] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

/** DERIVED from the order, never restated — a hand-written literal here could disagree with the set above. */
export const MOST_RESTRICTIVE_POLICY_DECISION: PolicyDecision = POLICY_DECISIONS[POLICY_DECISIONS.length - 1] as PolicyDecision;

export function isPolicyDecision(value: unknown): value is PolicyDecision {
  return typeof value === 'string' && (POLICY_DECISIONS as readonly string[]).includes(value);
}

/**
 * Position on the restrictiveness order. Higher is more restrictive.
 *
 * AN UNRECOGNISED VALUE RANKS AS THE MOST RESTRICTIVE, not as zero. Ranking it zero would make junk the *least*
 * restrictive input, so a malformed rule would lose every comparison and vanish from the result — a broken rule
 * silently behaving as `allow`.
 */
export function policyRank(value: unknown): number {
  const index = (POLICY_DECISIONS as readonly string[]).indexOf(value as string);
  return index === -1 ? POLICY_DECISIONS.length - 1 : index;
}

/** Total over `unknown`. Anything unreadable becomes `deny`. */
export function resolvePolicyDecision(value: unknown): PolicyDecision {
  return isPolicyDecision(value) ? value : MOST_RESTRICTIVE_POLICY_DECISION;
}

/**
 * Combine rule outcomes: most restrictive wins (POL-005).
 *
 * AN EMPTY SET DENIES. This is the rule-gap risk ADR-010 §10 names ("default-deny posture"). A policy with no
 * applicable rule has not permitted the action; it has failed to say anything about it. Returning `allow` for "no
 * rule matched" is how a default-open engine gets built by accident, one unwritten rule at a time — and it is the
 * single line most worth being certain about, because nothing downstream can recover from it.
 */
export function combinePolicyDecisions(values: Iterable<unknown> | undefined): PolicyDecision {
  if (values === undefined) return MOST_RESTRICTIVE_POLICY_DECISION;
  let winner: PolicyDecision | undefined;
  for (const value of values) {
    const decision = resolvePolicyDecision(value);
    if (winner === undefined || policyRank(decision) > policyRank(winner)) winner = decision;
  }
  return winner ?? MOST_RESTRICTIVE_POLICY_DECISION;
}

/**
 * One rule's answer: a decision, plus whether a denial should escalate (POL-005).
 *
 * `escalate` is meaningful only on `deny`. It is kept on every verdict rather than only on denials so the type stays
 * a plain record — a discriminated union here would buy nothing and cost every construction site a branch.
 */
export interface PolicyVerdict {
  readonly decision: PolicyDecision;
  readonly escalate: boolean;
}

/**
 * Combine verdicts: the most restrictive decision wins, and escalation is carried ONLY when the winner is a denial.
 *
 * ESCALATION DOES NOT LEAK DOWNWARD. A `deny(escalate)` that loses to nothing still escalates; a `require_approval`
 * result never reports escalation even if some other rule wanted one, because escalation is a property of refusing
 * an action, and `require_approval` has not refused it — it has asked a human. Reporting otherwise would page
 * someone about a decision that is merely waiting on them.
 */
export function combinePolicyVerdicts(verdicts: Iterable<PolicyVerdict> | undefined): PolicyVerdict {
  if (verdicts === undefined) return { decision: MOST_RESTRICTIVE_POLICY_DECISION, escalate: false };
  let decision: PolicyDecision | undefined;
  let escalate = false;
  for (const verdict of verdicts) {
    // A malformed verdict resolves to `deny`, exactly like a malformed decision — it is not skipped. A rule we could
    // not read has not been evaluated, and an unevaluated rule must never be indistinguishable from a permissive one.
    const resolved = resolvePolicyDecision((verdict as { decision?: unknown } | undefined)?.decision);
    if (decision === undefined || policyRank(resolved) > policyRank(decision)) decision = resolved;
    // Strictly `=== true`: only a real boolean escalates. A truthy string is a caller mistake, and reading it as
    // escalation would page a human because a rule was malformed. Denying quietly is the safer wrong answer.
    if (resolved === 'deny' && (verdict as { escalate?: unknown } | undefined)?.escalate === true) escalate = true;
  }
  const winner = decision ?? MOST_RESTRICTIVE_POLICY_DECISION;
  return { decision: winner, escalate: winner === 'deny' ? escalate : false };
}
