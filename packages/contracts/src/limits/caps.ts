// @acbp/contracts — cap evaluation (ACBP-P6-010; CDR-075; NFR-015 cost control; POL-001 spending limits;
// ADR-010, ADR-013; CDR-008 supplies the VALUES, this file supplies none).
//
// NO LIMIT VALUES LIVE HERE, and that is CDR-066 §3-G8's rule rather than this ticket's preference: a default
// limit is a statement about when a founder's money is spent without asking them. Every number reaching
// `evaluateCaps` comes from configuration (CDR-008 §8) by way of the caller.
//
// TOTAL AND PURE. No clock, no I/O, no exceptions — the same discipline `decideStepAdmission` (ACBP-P5-005) uses,
// and for the same reason: a cap check that can throw is a cap check that can be bypassed by whatever catches it.

export const LIMIT_SCOPES = ['company', 'account'] as const;
export type LimitScope = (typeof LIMIT_SCOPES)[number];

export const LIMIT_PERIODS = ['day', 'month'] as const;
export type LimitPeriod = (typeof LIMIT_PERIODS)[number];

/** The two thresholds EVENT-CATALOG:277 fixes for `usage.limit_reached`. */
export const LIMIT_THRESHOLDS = ['soft', 'hard'] as const;
export type LimitThreshold = (typeof LIMIT_THRESHOLDS)[number];

/**
 * One configured cap. `limitMicros` is the HARD ceiling in integer micro-units; `softPercent` is the alert
 * threshold as an integer percentage of it (CDR-008 §8 sets 75).
 *
 * `softPercent` is an integer rather than a fraction so the threshold is computed with integer arithmetic. A
 * `0.75` multiply is exact here by luck; a fraction that is not representable in binary would land the threshold
 * a fraction of a micro-unit off and compare wrong at exactly the boundary the alert exists to catch.
 */
export interface CapDefinition {
  readonly scope: LimitScope;
  readonly period: LimitPeriod;
  readonly limitMicros: number;
  readonly softPercent: number;
}

/** A cap paired with what has been spent in its scope and period. `null` means the total COULD NOT BE READ. */
export interface ObservedCap {
  readonly cap: CapDefinition;
  readonly spentMicros: number | null;
}

/** A cap that has been crossed, carried so the caller can name which one and by how much. */
export interface BreachedCap {
  readonly cap: CapDefinition;
  readonly spentMicros: number;
  readonly thresholdMicros: number;
}

/**
 * The decision. THREE outcomes, not two, because `block` and `halt` both stop work and mean opposite things:
 * `block` is "this account has spent its budget" — the founder's to act on — and `halt` is "we cannot tell what
 * has been spent", which is ours. Reporting the second as the first sends someone to top up an account that was
 * never the problem, and hides an outage behind a plausible business explanation.
 */
export type CapDecision =
  | { readonly outcome: 'allow'; readonly softBreaches: readonly BreachedCap[] }
  | { readonly outcome: 'block'; readonly blocking: BreachedCap; readonly softBreaches: readonly BreachedCap[] }
  | { readonly outcome: 'halt'; readonly unreadable: CapDefinition };

const isNonNegativeInteger = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** A cap whose own numbers are nonsense cannot be evaluated. Config defect, not a spend decision. */
function isEvaluable(cap: CapDefinition): boolean {
  return isNonNegativeInteger(cap.limitMicros) && isNonNegativeInteger(cap.softPercent) && cap.softPercent > 0 && cap.softPercent < 100;
}

/**
 * The soft-alert threshold in integer micro-units.
 *
 * FLOORED, not rounded: flooring can only make the alert fire at or before the stated percentage, and an alert
 * that arrives slightly early is harmless where one that arrives late is the whole failure.
 */
export function softThresholdMicros(cap: CapDefinition): number {
  return Math.floor((cap.limitMicros * cap.softPercent) / 100);
}

/**
 * Decide whether work may proceed against a set of observed caps.
 *
 * BLOCKS AT `spent >= limit`, which is what bounds the overrun to NFR-015's one billing increment: the check runs
 * BEFORE the call, so the most that can exceed the cap is the single call already decided. A `>` comparison would
 * let a call through at exactly the ceiling and overrun by two.
 *
 * UNREADABLE WINS OVER EVERYTHING (CDR-075 §3-G6). Checked in its own pass first, so evaluation order cannot
 * decide the answer — a blocking cap does not make an unreadable one readable, and returning `block` there would
 * assert a total nobody actually has.
 *
 * AN EMPTY SET ALLOWS. Rules restrict; they do not grant (CDR-066). A company with no configured cap is
 * unrestricted by this dimension, exactly as it was before this ticket. Making "unconfigured" mean deny is
 * CDR-067's landmine approached from the other side.
 */
export function evaluateCaps(observed: readonly ObservedCap[]): CapDecision {
  // OWN PASS, FIRST. Merging this into the loop below makes the answer depend on cap ORDER: an unreadable cap
  // discovered after a blocking one would be reported as `block`, asserting a total nobody has. Mutation-verified
  // — the merged form fails "halts on an unreadable cap even when another cap would have blocked first".
  for (const o of observed) {
    if (!isEvaluable(o.cap) || o.spentMicros === null || !isNonNegativeInteger(o.spentMicros)) {
      return { outcome: 'halt', unreadable: o.cap };
    }
  }

  const softBreaches: BreachedCap[] = [];
  let blocking: BreachedCap | undefined;

  for (const o of observed) {
    const spentMicros = o.spentMicros as number;
    if (spentMicros >= o.cap.limitMicros) {
      const breach = { cap: o.cap, spentMicros, thresholdMicros: o.cap.limitMicros };
      // MOST RESTRICTIVE WINS: the cap with the smallest ceiling is the one the caller must be told about, so a
      // founder raising the wrong limit does not find themselves still blocked.
      if (blocking === undefined || o.cap.limitMicros < blocking.cap.limitMicros) blocking = breach;
      continue;
    }
    const thresholdMicros = softThresholdMicros(o.cap);
    if (spentMicros >= thresholdMicros) softBreaches.push({ cap: o.cap, spentMicros, thresholdMicros });
  }

  return blocking !== undefined ? { outcome: 'block', blocking, softBreaches } : { outcome: 'allow', softBreaches };
}
