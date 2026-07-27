// @acbp/contracts — bounded retry and dead-lettering (ACBP-P5-001c; CDR-052; NFR-007; ADR-008). Zero-dep and PURE:
// no clock, no database, no job. The retry decision is arithmetic over an attempt count and a policy, so it is
// exhaustively testable without anything running.
//
// TWO GLOBAL RULES FROM CANON SHAPE EVERYTHING HERE (FAILURE-AND-RECOVERY, global rules):
//   "no unlimited retries — every retry policy is bounded with backoff (NFR-007)"
//   "non-idempotent actions are never retried without a safe idempotency mechanism (invariant 8)"
//
// The second is why the decision returns a CLOSED outcome rather than a boolean or a number: a runner that receives
// `{outcome: 'dead_lettered'}` cannot silently try again, whereas a runner handed a counter and left to decide can.

/** Why a job failed. CLOSED — a category the Decision Room can render, NEVER provider exception text (§3-G3). */
export const JOB_FAILURE_REASONS = ['attempts_exhausted', 'timeout', 'provider_error', 'invalid_payload', 'cancelled', 'internal_error'] as const;
export type JobFailureReason = (typeof JOB_FAILURE_REASONS)[number];

export function isJobFailureReason(value: unknown): value is JobFailureReason {
  return typeof value === 'string' && (JOB_FAILURE_REASONS as readonly string[]).includes(value);
}

/**
 * A bounded retry policy.
 *
 * Passed as a VALUE rather than read from a global, which is NFR-007's "config caps" without inventing a
 * configuration surface no requirement asks for yet: a caller that needs a different cap per job kind already can.
 */
export interface RetryPolicy {
  /** Total attempts allowed, INCLUDING the first. Must be finite and positive, or nothing is retried at all. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  /** The ceiling. "Bounded backoff" means a ceiling, not merely a formula — see `nextBackoffMs`. */
  readonly maxDelayMs: number;
}

/** The platform default. Deliberately small: a job that has failed three times is usually failing for a reason. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 };

/** Is this a usable, genuinely bounded policy? A non-finite cap is exactly what "no unlimited retries" forbids. */
function isBoundedPolicy(policy: RetryPolicy): boolean {
  return Number.isFinite(policy.maxAttempts) && policy.maxAttempts > 0;
}

/**
 * Delay before the next attempt, in milliseconds. Exponential, CLAMPED to `maxDelayMs`.
 *
 * The clamp is the load-bearing part. Uncapped exponential growth reaches delays measured in days, which is
 * indistinguishable from a job that never runs again — an unbounded wait wearing a retry's clothing.
 *
 * DETERMINISTIC, with no jitter. Jitter matters for thundering-herd avoidance, but it belongs to the polling loop
 * (CDR-052 §4): putting it here would make the contract untestable and the schedule unreproducible, for a property
 * only the runner needs. Naming it is better than silently omitting it.
 */
export function nextBackoffMs(attempt: number, policy: RetryPolicy): number {
  const base = Number.isFinite(policy.baseDelayMs) && policy.baseDelayMs > 0 ? policy.baseDelayMs : 0;
  const ceiling = Number.isFinite(policy.maxDelayMs) && policy.maxDelayMs >= 0 ? policy.maxDelayMs : base;
  // A malformed attempt number falls back to the first attempt's delay rather than producing NaN, which would
  // propagate into a scheduler as a delay of "unknown" — the worst possible value for a wait.
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  const raw = base * 2 ** (n - 1);
  return Math.min(Number.isFinite(raw) ? raw : ceiling, ceiling);
}

export type RetryOutcome =
  | { readonly outcome: 'retry_scheduled'; readonly nextAttempt: number; readonly delayMs: number }
  // Terminal and VISIBLE. There is deliberately no third variant: a closed union of exactly two is what makes
  // "never silently retried" a property of the type rather than of the caller's discipline (§3-G1).
  //
  // It carries NO reason, which review pass 2 corrected. This function decides retry-vs-stop; it does not know WHY
  // the attempt failed, and a placeholder ttempts_exhausted here contradicted the caller's real cause, which is
  // what actually gets persisted. That the cap was reached is already recorded by ttempts == maxAttempts — a
  // second, weaker statement of the same fact is not information, it is a chance for two records to disagree.
  | { readonly outcome: 'dead_lettered' };

/**
 * Decide what happens after a failed attempt. FAILS CLOSED in every ambiguous case.
 *
 * `attemptsSoFar` is the count INCLUDING the attempt that just failed. Reaching `maxAttempts` dead-letters; the
 * boundary is exact, because off-by-one here means exceeding the cap by one attempt on every single job.
 *
 * A corrupt counter (NaN, negative, fractional) or an unbounded policy dead-letters rather than retrying. That
 * direction is not arbitrary: the failure mode of guessing "retry" is an infinite loop burning budget on work that
 * has already failed, while the failure mode of guessing "stop" is a job a human can see and re-queue.
 */
export function classifyRetryOutcome(attemptsSoFar: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): RetryOutcome {
  if (!isBoundedPolicy(policy)) return { outcome: 'dead_lettered' };
  if (!Number.isInteger(attemptsSoFar) || attemptsSoFar < 0) return { outcome: 'dead_lettered' };
  if (attemptsSoFar >= policy.maxAttempts) return { outcome: 'dead_lettered' };
  const nextAttempt = attemptsSoFar + 1;
  return { outcome: 'retry_scheduled', nextAttempt, delayMs: nextBackoffMs(nextAttempt, policy) };
}
