// @acbp/contracts — account usage rollup contract (ACBP-P6-009; CDR-073; USAGE-001 amended, ADR-013, ADR-003 §16).
//
// The provider-neutral shape of the per-`(account_id, period)` aggregation described in
// `USAGE-AND-BILLING-ARCHITECTURE` §2, plus the arithmetic the rebuild and the reconciliation share.
//
// THE ROLLUP IS A PROJECTION, NOT A SOURCE OF TRUTH (CDR-073 §1-G1). Every figure here is reproducible by
// summing `usage_events` + `usage_corrections`; when the two disagree the LEDGER is right. Nothing in this
// module may be used to authorize a billing, limit or entitlement decision.
//
// Zero-dependency and framework-neutral, per the package's boundary rule. The physical rows live in
// @acbp/database (migration 0051); this is the semantic seam.

/**
 * The lanes a rollup carries — CDR-073 §1-G7, drawn from the five-number separation in `USAGE-AND-BILLING` §1.
 *
 * TECHNICAL USAGE (`eventCount`, `inputTokens`, `outputTokens`) and PROVIDER COST ESTIMATE
 * (`estimatedCostMicros`) only. Billable usage, included entitlement and user-visible credits are deliberately
 * ABSENT: D-02 (the commercial formula) is open, and canon requires this design to support flat, usage-based and
 * hybrid pricing without schema change. Credits already have their own append-only ledger
 * (`credit_transactions`), so a total here would be a second source of truth.
 *
 * The order is closed and load-bearing: `lanesExceedingThreshold` reports in it.
 */
export const USAGE_ROLLUP_LANES = ['eventCount', 'inputTokens', 'outputTokens', 'estimatedCostMicros'] as const;

export type UsageRollupLane = (typeof USAGE_ROLLUP_LANES)[number];

/**
 * One lane-keyed set of figures. Used for THREE different things whose arithmetic is identical: a period's
 * totals, a correction's signed deltas (CDR-073 §1-G9), and a computed-minus-stored drift (§1-G11). Values are
 * SIGNED for that reason — a correction subtracts.
 *
 * Money is integer micro-units, never a float. Counts are integers.
 */
export type RollupFigures = { readonly [K in UsageRollupLane]: number };

/**
 * A period key: the first day of a UTC calendar month, `YYYY-MM-01`.
 *
 * Not branded — a plain string with a documented shape and a guard (`isUsagePeriodStart`), matching how the rest
 * of the package treats validated identifiers.
 */
export type UsagePeriodStart = string;

/**
 * THE PERIOD DERIVATION (CDR-073 §1-G8) — the single place an instant becomes a period key.
 *
 * The bucket is the instant's **UTC** calendar month. UTC rather than local time because the bucket must be a
 * pure function of the row: a local-zone derivation would file the same event under different periods depending
 * on where the process runs, and the totals would differ between two correct-looking servers.
 *
 * The database side computes the same thing as `date_trunc('month', created_at at time zone 'UTC')`. Both paths
 * must agree; the integration suite asserts they do on the same rows rather than trusting this comment.
 *
 * Throws on an invalid Date instead of formatting `NaN` into a period key — a malformed key would become a real
 * row and silently split one period in two.
 */
export function usagePeriodStart(instant: Date): UsagePeriodStart {
  const ms = instant.getTime();
  if (Number.isNaN(ms)) {
    throw new TypeError('usagePeriodStart received an invalid Date');
  }
  const year = String(instant.getUTCFullYear()).padStart(4, '0');
  const month = String(instant.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

/**
 * Shape guard for a period key arriving from outside (a query string, a job payload, a stored row).
 *
 * Requires the first of the month: the period key IS the month, so a mid-month date is not a stricter version of
 * the same thing — it is a different key that would create a second row for one period.
 *
 * Year `0000` is excluded because it is not a date PostgreSQL accepts (there is no year zero), and this guard's
 * whole job is to refuse a bad period BEFORE a scope is established. Letting `'0000-01-01'` through would have
 * carried it all the way to `${periodStart}::date` in the aggregation, where it raises `22008` — a thrown error
 * where `invalid_period` is the answer the caller should get.
 */
export function isUsagePeriodStart(value: unknown): value is UsagePeriodStart {
  return typeof value === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])-01$/.test(value);
}

/** All lanes at zero — the identity for {@link addRollupFigures}, and the starting point of a rebuild fold. */
export function emptyRollupFigures(): RollupFigures {
  return { eventCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 };
}

/**
 * Lane-wise addition. Returns a new object and mutates neither operand — the rebuild folds over the account's
 * companies with this, and an in-place add would corrupt an earlier company's partial total.
 *
 * Accepts negative values because a correction is a signed compensating entry (CDR-073 §1-G9): the rollup is
 * `sum(events) + sum(corrections)`.
 */
export function addRollupFigures(a: RollupFigures, b: RollupFigures): RollupFigures {
  return {
    eventCount: a.eventCount + b.eventCount,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    estimatedCostMicros: a.estimatedCostMicros + b.estimatedCostMicros,
  };
}

/**
 * COMPUTED minus STORED, per lane (CDR-073 §1-G11).
 *
 * Signed on purpose: a projection that is SHORT and one that is OVER have different causes (a missed event
 * versus a double-counted one), and collapsing them to a magnitude would throw away the half of the signal that
 * says which bug to look for.
 */
export function rollupFigureDrift(computed: RollupFigures, stored: RollupFigures): RollupFigures {
  return {
    eventCount: computed.eventCount - stored.eventCount,
    inputTokens: computed.inputTokens - stored.inputTokens,
    outputTokens: computed.outputTokens - stored.outputTokens,
    estimatedCostMicros: computed.estimatedCostMicros - stored.estimatedCostMicros,
  };
}

/**
 * The lanes whose drift MAGNITUDE exceeds the caller's tolerance, in {@link USAGE_ROLLUP_LANES} order.
 *
 * Magnitude, so an over-count alerts exactly as an under-count does. EXCLUSIVE (`>`), so a tolerance of 0 means
 * "any difference at all alerts" and a drift exactly equal to the tolerance is within it.
 *
 * The THRESHOLD VALUES ARE THE OWNER'S (CDR-073 §3, launch gate 7) — this function takes them as a parameter and
 * there is deliberately no default anywhere in the package. A caller must supply one.
 */
export function lanesExceedingThreshold(drift: RollupFigures, threshold: RollupFigures): readonly UsageRollupLane[] {
  return USAGE_ROLLUP_LANES.filter((lane) => Math.abs(drift[lane]) > threshold[lane]);
}
