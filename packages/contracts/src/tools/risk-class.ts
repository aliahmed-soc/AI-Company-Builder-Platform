// @acbp/contracts — tool risk classes (ACBP-P5-003a; CDR-051; TOOL-001 / APPR-001; ADR-010/ADR-012). Zero-dep.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE FOURTH CLASS IS NOW CANON'S OWN NAME. Owner decision, 2026-07-28. See CDR-051 §0.1 and §0.2.
//
// APPR-001 enumerates the classes by name — `informational · internal-reversible · external · sensitive-irreversible`
// — and an earlier note in this file claimed canon never did. That claim was wrong (it was asserted after searching
// only the architecture layer, not the requirements row this module's own header cites), and the owner's original
// approval of the invented `external_irreversible` rested on it.
//
// The rename is NOT cosmetic, and that is the point. `external_irreversible` tied the top class to EXTERNAL effects,
// so an irreversible INTERNAL action — permanently destroying a company's data, say — had no home above
// `internal_reversible`, the second-LEAST restrictive value. `sensitive_irreversible` is about sensitivity and
// irreversibility WHEREVER they occur, which is what canon means and what a classifier can now honestly assign.
//
// The ORDERING and every rank are unchanged, and the rename is proven behaviour-preserving (see risk-class.test.ts:
// "the correction changed the NAME and nothing else").
//
// STILL DIFFERENT FROM CANON, deliberately and flagged: canon's third class is plain `external`, this set splits it
// into `external_reversible`. That split was mine and the owner has not ruled on it; it is recorded in CDR-051 §0.2
// rather than changed unilaterally alongside a correction the owner did rule on.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// What the tests pin regardless of naming: that the set is ORDERED (TOOL-001's "most restrictive" is meaningless
// otherwise), and that anything unclassified resolves to the most restrictive class.

/** Ordered LEAST → MOST restrictive. The order is the contract (CDR-051 §2-G3), not an implementation detail. */
export const RISK_CLASSES = ['informational', 'internal_reversible', 'external_reversible', 'sensitive_irreversible'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/**
 * The class an unclassified tool is treated as — TOOL-001's *"unclassified = most restrictive"*.
 *
 * Derived from the array rather than written as a literal, so it cannot drift if the set is revisited (which §0 says
 * it should be). A hand-written literal here would be the one place a three-class rework would silently miss.
 */
export const MOST_RESTRICTIVE_RISK_CLASS: RiskClass = RISK_CLASSES[RISK_CLASSES.length - 1] as RiskClass;

export function isRiskClass(value: unknown): value is RiskClass {
  return typeof value === 'string' && (RISK_CLASSES as readonly string[]).includes(value);
}

/**
 * Position in the ordering. Higher = more restrictive.
 *
 * Exported as a comparable number because P6-001 will compare a tool's class against a policy threshold and APPR-005
 * will key expiry defaults to it. Leaving the order implicit in array position would make every consumer re-derive it,
 * and re-derivations disagree.
 *
 * TAKES `unknown` AND RESOLVES, which is not defensive clutter — it closes a gate bypass found in review. Typed as
 * `RiskClass` it looked safe, but TypeScript types are erased at runtime: a cast (`row.risk_class as RiskClass`, the
 * obvious thing to write at a database boundary) or any JavaScript caller could pass an unclassified value, and a bare
 * `indexOf` returns **-1** for it — BELOW `informational`, i.e. the least restrictive rank possible. The one function
 * here that could inverted the ordering this module exists to enforce.
 */
export function riskRank(value: unknown): number {
  return RISK_CLASSES.indexOf(resolveRiskClass(value));
}

/**
 * Resolve a stored class into an effective one. NEVER throws, and never returns anything but a member of the set.
 *
 * The fallback is the MOST restrictive class, and that direction is the entire point: defaulting an unrecognised value
 * to `informational` would let a tool whose registration is broken execute ungated, and the failure would be silent —
 * nothing errors, and an external-effect tool runs as though it had read a document.
 *
 * It does not throw because refusing would be a denial of service on the whole registry (CDR-051 §2-G2). One broken
 * row must not stop every other tool from dispatching; the call proceeds, under the strictest gate.
 */
export function resolveRiskClass(stored: unknown): RiskClass {
  return isRiskClass(stored) ? stored : MOST_RESTRICTIVE_RISK_CLASS;
}

/**
 * Is `candidate` at least as restrictive as `threshold`?
 *
 * Both sides go through {@link resolveRiskClass} first, so an unclassified candidate compares as the most restrictive
 * value. Without that, a caller could slip under a policy threshold by passing a class the registry failed to record —
 * turning a broken registration into a gate bypass.
 */
export function isAtLeastAsRestrictiveAs(candidate: unknown, threshold: unknown): boolean {
  return riskRank(resolveRiskClass(candidate)) >= riskRank(resolveRiskClass(threshold));
}

/**
 * The classes treated as having an effect that reaches OUTSIDE the platform. TOOL-002's receipt rule keys off this.
 *
 * IT LIVES HERE, not in the dispatcher, because it is a safety rule and a rule provable only through a database is a
 * rule most runs never check (review pass 1 on the canon correction: the dispatcher held this privately, so the sole
 * proof was a real-PostgreSQL suite that skips on a laptop).
 *
 * `sensitive_irreversible` is included as an OVER-APPROXIMATION and that is deliberate. Canon's class covers
 * sensitivity and irreversibility wherever they occur, so a member may be an INTERNAL action with no external receipt
 * to store — but excluding it would RELAX TOOL-002's rule on the most dangerous class there is, and over-refusing a
 * receiptless success is the safe direction.
 *
 * THE PROPER HOME IS A DIFFERENT FIELD. TOOL-001 asks a registered tool to declare its *"side-effect class"*
 * separately from its risk category; deriving it from the class is a stand-in until a tool declares it (CDR-051 §0.2).
 */
export const EXTERNAL_EFFECT_RISK_CLASSES: readonly RiskClass[] = ['external_reversible', 'sensitive_irreversible'];

/** Does a call at this class need a stored receipt to claim success? Deny-by-default: unclassified counts as external. */
export function hasExternalEffect(value: unknown): boolean {
  return EXTERNAL_EFFECT_RISK_CLASSES.includes(resolveRiskClass(value));
}
