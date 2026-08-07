// @acbp/contracts — the token bucket that expresses CDR-008 §8's request limits (ACBP-P7-013; CDR-082 §3.2).
//
// ── WHY A TOKEN BUCKET AND NOT A WINDOW ──────────────────────────────────────────────────────────────────────
//
// CDR-008 §8 rules "60 req/min sustained, burst 120" — two numbers about one limit, and only one structure holds
// both. A fixed 60/min window forbids the burst; a fixed 120/min window doubles the ruled sustained rate; a
// sliding 60/min window forbids the burst too. A bucket of capacity 120 refilling at 60/min means exactly what
// §8 says, and `sustains exactly the ruled rate once the burst is spent` in the test file measures that property
// rather than asserting it.
//
// ── THIS MODULE IS THE SPECIFICATION, AND SOMETHING ELSE EXECUTES IT ─────────────────────────────────────────
//
// Production consumes a bucket in ONE SQL statement, because a read-then-write pair is a lost-update race in
// which two concurrent requests observe the same balance and both spend it — the exact defect this control
// exists to prevent, reintroduced inside its own implementation (CDR-082 §3.2). That leaves two implementations
// of one rule, which is a drift risk, so it is closed the way ACBP-P7-001 closed its table classification: with
// a DIFFERENTIAL test against a second anchor. `rate-limit-bucket.integration.test.ts` replays this file's cases
// through real PostgreSQL and asserts the database agrees with this function, case for case. Divergence is a red
// test; it is not a judgement call made later by whoever notices.
//
// Everything here is pure, integer-only and total: no clock, no I/O, no throw on any state value. A limiter that
// throws on a corrupt row is a limiter that fails OPEN under exactly the conditions that produce corrupt rows.

/** Milli-tokens per token. Balances are integers for the same reason money is: a float refill drifts. */
export const MILLI = 1000;

/** A ruled limit, already reduced to the two quantities the bucket needs. Build with `rateLimitRule`. */
export interface RateLimitRule {
  /** The burst ceiling, in milli-tokens. A bucket never refills above this. */
  readonly capacityMilli: number;
  /** The sustained rate, in milli-tokens per second. May be fractional; accrual is floored to an integer. */
  readonly refillMilliPerSecond: number;
}

/** A stored bucket. `null` at the call site means "no row yet", which starts full — see `consumeTokens`. */
export interface BucketState {
  readonly milli: number;
  readonly atMs: number;
}

/**
 * The verdict. One shape, not a discriminated union, because every field is meaningful in both outcomes and a
 * caller that must narrow before reading the remaining balance tends to stop reading it.
 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  /** The balance AFTER this decision. Never negative, never above capacity. Unchanged when refused. */
  readonly remainingMilli: number;
  /** Whole seconds until one token is available. `0` when allowed; never `0` when refused. */
  readonly retryAfterSeconds: number;
}

/** The per-minute figures as CDR-008 §8 states them. `burst` defaults to `perMinute` (no separate burst ruled). */
export interface RateLimitSpec {
  readonly perMinute: number;
  readonly burst?: number;
}

/**
 * Reduce CDR-008 §8's figures to a bucket.
 *
 * THROWS ON A RULE THAT CANNOT REFUSE OR CANNOT ADMIT. Both are configuration errors that produce a limiter
 * which is silently useless (`perMinute <= 0` never refills, so after the burst everything is refused forever)
 * or a permanent outage (`burst < 1` can never satisfy a one-token request). Neither should be discoverable in
 * production, and a config value is validated once at startup rather than on every request.
 */
export function rateLimitRule(spec: RateLimitSpec): RateLimitRule {
  const { perMinute } = spec;
  if (!Number.isFinite(perMinute) || perMinute <= 0) {
    throw new TypeError('rateLimitRule: `perMinute` must be a positive finite number — a non-refilling bucket refuses everything after its burst.');
  }
  const burst = spec.burst ?? perMinute;
  if (!Number.isFinite(burst) || burst < 1) {
    throw new TypeError('rateLimitRule: `burst` must be at least 1 — a capacity below one token can never satisfy a request.');
  }
  return {
    capacityMilli: Math.floor(burst * MILLI),
    refillMilliPerSecond: (perMinute * MILLI) / 60,
  };
}

/** Clamp a stored balance into the representable range. A corrupt row reads as empty or as full, never as credit. */
function clampStored(milli: number, capacityMilli: number): number {
  if (!Number.isFinite(milli) || milli <= 0) return 0;
  return Math.min(Math.floor(milli), capacityMilli);
}

/**
 * Decide one request against a bucket.
 *
 * `state === null` starts FULL. A key seen for the first time has by definition not yet spent anything, and
 * starting empty would refuse every user's first request — the limiter would be an outage on first contact.
 *
 * A REFUSAL DOES NOT SPEND. A throttled client that still paid a token could hold its own bucket at zero
 * indefinitely by retrying, converting a temporary limit into a permanent one it cannot escape.
 *
 * The clock is the caller's and moving BACKWARDS accrues nothing rather than draining: an NTP correction must
 * not empty a bucket.
 */
export function consumeTokens(
  rule: RateLimitRule,
  state: BucketState | null,
  nowMs: number,
  costMilli: number = MILLI,
): RateLimitDecision {
  const { capacityMilli, refillMilliPerSecond } = rule;

  const available =
    state === null
      ? capacityMilli
      : Math.min(
          capacityMilli,
          clampStored(state.milli, capacityMilli) + accrued(nowMs - state.atMs, refillMilliPerSecond),
        );

  if (available >= costMilli) {
    return { allowed: true, remainingMilli: available - costMilli, retryAfterSeconds: 0 };
  }
  return {
    allowed: false,
    remainingMilli: available,
    // Rounded UP and floored at 1: advice that is early is advice that produces a second refusal, and
    // `Retry-After: 0` invites an immediate retry certain to fail.
    retryAfterSeconds: Math.max(1, Math.ceil((costMilli - available) / refillMilliPerSecond)),
  };
}

/** Milli-tokens accrued over an elapsed span. Floored to an integer so stored balances stay integers. */
function accrued(elapsedMs: number, refillMilliPerSecond: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.floor((elapsedMs * refillMilliPerSecond) / 1000);
}
