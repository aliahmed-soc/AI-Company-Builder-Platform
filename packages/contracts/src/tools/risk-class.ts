// @acbp/contracts — tool risk classes (ACBP-P5-003a; CDR-051; TOOL-001 / APPR-001; ADR-010/ADR-012). Zero-dep.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE SET BELOW IS OWNER-APPROVED BY DEFAULT AND PROVISIONAL. See CDR-051 §0 before relying on it.
//
// Canon never enumerates the risk classes. It uses `informational` and `internal-reversible` as its own words
// (AI-AND-WORKER-ARCHITECTURE:41) and treats "external" as ONE undifferentiated group. Splitting that group into
// reversible / irreversible is an ADDITION to canon, not a reading of it. The owner approved this four-class set
// as-is on 2026-07-27 specifically to unblock P5-003b/c, and asked that it be recorded as a default to revisit — a
// three-class set (`informational`, `internal_reversible`, `external`) is equally consistent and simpler.
//
// It is cheap to change NOW and expensive once P6-001 policy rows and APPR-005 expiry defaults key off these values.
// The MVP is structurally zero-external-actions (ADR-012), so nothing in the MVP exercises classes 2 or 3 either way.
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
