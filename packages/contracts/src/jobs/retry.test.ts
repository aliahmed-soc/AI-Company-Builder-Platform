// ACBP-P5-001c — NFR-007's "no unlimited retries" and "cap = dead-letter", made executable (CDR-052).
//
// The failure being excluded is a job that retries forever, or worse, one that exhausts its cap and is quietly
// retried anyway — burning budget on work that has already failed as many times as the platform allows, with nobody
// able to see it. Every case below is a shape that, decided wrongly, produces one of those two.
import { describe, test, expect } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  JOB_FAILURE_REASONS,
  isJobFailureReason,
  nextBackoffMs,
  classifyRetryOutcome,
  type RetryPolicy,
} from './retry.js';

const POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 };

describe('the retry policy', () => {
  test('the platform default is BOUNDED — an unbounded default would defeat NFR-007 by omission', () => {
    expect(Number.isFinite(DEFAULT_RETRY_POLICY.maxAttempts)).toBe(true);
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_RETRY_POLICY.maxDelayMs)).toBe(true);
  });
});

describe('nextBackoffMs — bounded backoff', () => {
  test('grows with the attempt number', () => {
    expect(nextBackoffMs(1, POLICY)).toBeLessThan(nextBackoffMs(2, POLICY));
    expect(nextBackoffMs(2, POLICY)).toBeLessThan(nextBackoffMs(3, POLICY));
  });

  test('is CLAMPED — "bounded backoff" means a ceiling, not merely a formula', () => {
    // Without the clamp, exponential growth reaches delays measured in days, which is indistinguishable from a job
    // that never runs again — an unbounded wait dressed up as a retry.
    for (const attempt of [1, 5, 20, 100, 10_000]) {
      expect(nextBackoffMs(attempt, POLICY)).toBeLessThanOrEqual(POLICY.maxDelayMs);
    }
  });

  test('is never negative or NaN, for any attempt number a caller could pass', () => {
    for (const attempt of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const ms = nextBackoffMs(attempt, POLICY);
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });

  test('is deterministic — the same inputs give the same delay', () => {
    // Jitter is a RUNNER concern (CDR-052 §4). Putting it here would make the contract untestable and the schedule
    // unreproducible, which is a bad trade for a property only the polling loop needs.
    expect(nextBackoffMs(2, POLICY)).toBe(nextBackoffMs(2, POLICY));
  });
});

describe('classifyRetryOutcome — the single decision, with no third answer', () => {
  test('below the cap, a failure schedules a retry', () => {
    const r = classifyRetryOutcome(1, POLICY);
    expect(r.outcome).toBe('retry_scheduled');
    if (r.outcome !== 'retry_scheduled') throw new Error('unreachable');
    expect(r.nextAttempt).toBe(2);
    expect(r.delayMs).toBeGreaterThan(0);
  });

  test('AT the cap, the job is dead-lettered — the acceptance clause, exactly', () => {
    expect(classifyRetryOutcome(POLICY.maxAttempts, POLICY).outcome).toBe('dead_lettered');
  });

  test('PAST the cap it stays dead-lettered — a miscounting caller cannot talk it into another attempt', () => {
    for (const attempts of [POLICY.maxAttempts + 1, POLICY.maxAttempts + 50, 10_000]) {
      expect(classifyRetryOutcome(attempts, POLICY).outcome).toBe('dead_lettered');
    }
  });

  test('the boundary is exact — one below the cap retries, the cap itself does not', () => {
    // Off-by-one here is the difference between honouring the cap and exceeding it by one attempt every time.
    expect(classifyRetryOutcome(POLICY.maxAttempts - 1, POLICY).outcome).toBe('retry_scheduled');
    expect(classifyRetryOutcome(POLICY.maxAttempts, POLICY).outcome).toBe('dead_lettered');
  });

  test('a nonsense attempt count DEAD-LETTERS rather than retrying — fail closed', () => {
    // A corrupt or missing counter must not become an unbounded retry loop. The safe direction is to stop.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(classifyRetryOutcome(bad, POLICY).outcome).toBe('dead_lettered');
    }
  });

  test('a policy with maxAttempts <= 0 dead-letters immediately rather than looping', () => {
    expect(classifyRetryOutcome(0, { ...POLICY, maxAttempts: 0 }).outcome).toBe('dead_lettered');
    expect(classifyRetryOutcome(0, { ...POLICY, maxAttempts: -5 }).outcome).toBe('dead_lettered');
  });

  test('a policy with a non-finite maxAttempts is REFUSED as unbounded, not honoured', () => {
    // "No unlimited retries" is a global rule; a caller passing Infinity is asking for exactly what canon forbids.
    expect(classifyRetryOutcome(1, { ...POLICY, maxAttempts: Number.POSITIVE_INFINITY }).outcome).toBe('dead_lettered');
  });

  test('the outcome union is CLOSED — there is no answer meaning "try again anyway"', () => {
    const outcomes = new Set([
      classifyRetryOutcome(1, POLICY).outcome,
      classifyRetryOutcome(POLICY.maxAttempts, POLICY).outcome,
    ]);
    for (const o of outcomes) expect(['retry_scheduled', 'dead_lettered']).toContain(o);
  });
});

describe('failure reasons', () => {
  test('are a CLOSED set — a reason is a category, never provider exception text', () => {
    // The same rule the model gateway follows for usage_events.error_category: an open string here would put
    // arbitrary provider text into a record the Decision Room renders.
    for (const r of JOB_FAILURE_REASONS) expect(isJobFailureReason(r)).toBe(true);
    for (const bad of ['ECONNREFUSED at 10.0.0.1:5432', '', null, undefined, 42]) {
      expect(isJobFailureReason(bad)).toBe(false);
    }
  });

  test('include the attempt-cap category, for a caller with no more specific cause', () => {
    expect(isJobFailureReason('attempts_exhausted')).toBe(true);
  });

  test('the DECISION carries no reason - it decides retry-vs-stop and does not know why the attempt failed', () => {
    // Review pass 2: a placeholder reason here contradicted the caller's real cause, which is what gets persisted.
    const r = classifyRetryOutcome(POLICY.maxAttempts, POLICY);
    expect(r).toEqual({ outcome: 'dead_lettered' });
  });
});
