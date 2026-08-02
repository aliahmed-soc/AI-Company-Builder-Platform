// @acbp/contracts — the UTC day key for daily caps (ACBP-P6-010; CDR-075 §3-G13; CDR-008 §8's $5/day).
//
// The daily twin of `usagePeriodStart`. Kept as its own function rather than a parameter on that one for the
// reason CDR-075 §3.1 records: the `date_trunc` expression it mirrors must agree EXACTLY with the repository's,
// that agreement is held only by a test running under a UTC+14 session zone, and putting the expression behind a
// branch puts the pin behind a branch too.

/** `YYYY-MM-DD`, always a UTC calendar day. */
export type UsageDayStart = string;

/**
 * The UTC calendar day `instant` falls in.
 *
 * MUST AGREE with `date_trunc('day', created_at at time zone 'UTC')` in
 * `AccountUsageRollupRepository.sumCompanyUsageForDay`. The expression exists twice — here and there — and only
 * an integration test running under a non-UTC session zone holds them together.
 *
 * WHY UTC RATHER THAN THE FOUNDER'S ZONE, and it bites harder for days than for months: a daily cap read in local
 * time resets at local midnight, so a founder in UTC+14 gets a fresh daily allowance fourteen hours before one in
 * UTC, and the same account enforces two different ceilings depending on which server answered the call. A
 * founder-local daily window is a defensible PRODUCT choice, but it is a product choice nobody has made, and
 * inventing it here would make the cap depend on a timezone the platform never asked for.
 *
 * Throws on an invalid Date rather than formatting `NaN` into a key: a malformed key reaches `${dayStart}::date`
 * inside a cap decision, and a cap whose outcome depends on where it failed is worse than one that refuses.
 */
export function usageDayStart(instant: Date): UsageDayStart {
  const ms = instant.getTime();
  if (Number.isNaN(ms)) {
    throw new TypeError('usageDayStart received an invalid Date');
  }
  const year = String(instant.getUTCFullYear()).padStart(4, '0');
  const month = String(instant.getUTCMonth() + 1).padStart(2, '0');
  const day = String(instant.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Is this a well-formed UTC day key?
 *
 * Year `0000` is excluded for the same reason `isUsagePeriodStart` excludes it: PostgreSQL has no year zero, so
 * `'0000-…'` raises `22008` at `::date` — a thrown error where a typed refusal is the answer the caller wants,
 * and this guard's job is to refuse before a scope is established.
 */
export function isUsageDayStart(value: unknown): value is UsageDayStart {
  return typeof value === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value);
}
