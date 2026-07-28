// @acbp/contracts — tool risk classes (ACBP-P5-003a; CDR-051; TOOL-001 / APPR-001; ADR-010/ADR-012). Zero-dep.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE SET BELOW IS OWNER-APPROVED BY DEFAULT AND PROVISIONAL, AND IT DISAGREES WITH CANON. See CDR-051 §0.
//
// CORRECTION (found while researching P5-003b). An earlier version of this comment said "canon never enumerates the
// risk classes". THAT WAS WRONG, and the owner's approval of this set was given on that mistaken basis. APPR-001
// enumerates four classes by name:
//
//     informational · internal-reversible · external · sensitive-irreversible
//
// Four, as here — but the FOURTH IS NOT THE SAME CLASS. Canon's is `sensitive-irreversible`, which is about
// sensitivity and irreversibility wherever they occur; this set's is `external_irreversible`, which ties the top two
// classes to EXTERNAL effects. The gap is not cosmetic: an irreversible INTERNAL action (permanently destroying a
// company's data, say) is canon's most restrictive class, and under this set it has no home above
// `internal_reversible` — the second-LEAST restrictive value.
//
// That is a decision the owner reserved, so it is flagged and not changed here; see AUTONOMOUS-RUN-LOG.md. Nothing
// downstream keys off these NAMES — P5-003b dispatches on `resolveRiskClass` and the ordering alone — so realigning
// the set stays cheap until P6-001 policy rows and APPR-005 expiry defaults reference the values.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// What is NOT provisional, and what the tests actually pin: that the set is ORDERED (TOOL-001's "most restrictive"
// is meaningless otherwise), and that anything unclassified resolves to the most restrictive class.

/** Ordered LEAST → MOST restrictive. The order is the contract (CDR-051 §2-G3), not an implementation detail. */
export const RISK_CLASSES = ['informational', 'internal_reversible', 'external_reversible', 'external_irreversible'] as const;
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
