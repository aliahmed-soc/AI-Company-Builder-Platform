// ACBP-P5-013 — failure detail and visible retries, made executable (CDR-059; TASK-006; TASK-010; ACT-005).
//
// TASK-006 states the standard in three words: NO BLANK FAILURES. So the tests that matter here are the ugly inputs —
// a missing category, a nonsense attempt count, a run that failed before anyone recorded why. Every one of them has to
// produce a complete, honest answer.
import { describe, test, expect } from 'vitest';
import {
  RUN_FAILURE_CATEGORIES,
  describeRunFailure,
  RETRY_SAFE_CATEGORIES,
  FAILURE_SUMMARIES,
  DEFAULT_RETRY_POLICY,
} from '../index.js';

/**
 * A failed run's detail, asserted non-null.
 *
 * `describeRunFailure` returns null only for a run that did NOT fail — which is its own test below. Every use here
 * passes `state: 'failed'`, so a null would itself be a bug, and the assertion says that rather than the tests
 * quietly optional-chaining past it.
 */
const detail = (over: Partial<Parameters<typeof describeRunFailure>[0]> = {}) => {
  const d = describeRunFailure({ state: 'failed', failureCategory: 'provider_error', attempt: 1, ...over });
  expect(d).not.toBeNull();
  return d as NonNullable<typeof d>;
};

describe('describeRunFailure — TOTAL, and never blank (TASK-006)', () => {
  test('every registered category produces a complete detail', () => {
    for (const category of RUN_FAILURE_CATEGORIES) {
      const d = detail({ failureCategory: category });
      expect(d.category).toBe(category);
      expect(d.summary.length).toBeGreaterThan(10);
      expect(d.summary.trim()).toBe(d.summary);
      expect(Number.isInteger(d.attemptsUsed)).toBe(true);
      expect(Number.isInteger(d.attemptsAllowed)).toBe(true);
      expect(['safe', 'unsafe']).toContain(d.retrySafety);
      expect(['retry_eligible', 'exhausted', 'not_eligible']).toContain(d.nextAttempt);
    }
  });

  test('A MISSING CATEGORY IS `unknown`, AND THE SUMMARY SAYS SO — never blank, never "Error"', () => {
    // The backlog's failure behaviour verbatim: "Unknown cause labeled unknown never blank". A run can fail before
    // anything records why — a crash between the transition and the category write — and that is a real state a
    // founder can land on, not a theoretical one.
    for (const missing of [null, undefined, '', '   ']) {
      const d = detail({ failureCategory: missing });
      expect(d.category).toBe('unknown');
      expect(d.summary).toBe(FAILURE_SUMMARIES.unknown);
      expect(d.summary).not.toBe('');
      expect(d.summary.toLowerCase()).toContain('could not be determined');
    }
  });

  test('an UNRECOGNISED category is also `unknown` — a stored string is never echoed at a founder', () => {
    // Echoing it would put provider text or a future category name in front of someone, and would let an unbounded
    // string out of the boundary. `unknown` is the honest answer for "we have a value we cannot interpret".
    for (const bogus of ['ProviderError', 'boom', 'timeout ', 42, {}]) {
      expect(detail({ failureCategory: bogus }).category).toBe('unknown');
    }
  });

  test('the summary map covers EVERY category and unknown — set equality, not containment', () => {
    // A category added to the contract and forgotten in the map would render a blank failure, which is the one thing
    // TASK-006 forbids. This is the guard that makes forgetting impossible rather than unlikely.
    expect(Object.keys(FAILURE_SUMMARIES).sort()).toEqual([...RUN_FAILURE_CATEGORIES, 'unknown'].sort());
    for (const sentence of Object.values(FAILURE_SUMMARIES)) {
      expect(sentence.length).toBeGreaterThan(10);
      expect(sentence).not.toMatch(/undefined|null|\[object/i);
    }
  });

  test('a run that has NOT failed gets no failure detail', () => {
    // Describing a running or succeeded run as though it had failed would be a different kind of blank: a complete
    // answer to a question nobody asked.
    for (const state of ['queued', 'running', 'succeeded', 'cancelled']) {
      expect(describeRunFailure({ state, failureCategory: null, attempt: 1 })).toBeNull();
    }
  });
});

describe('retry visibility (TASK-010 — "bounded retries only", and VISIBLY so)', () => {
  test('attempts used and attempts allowed are DIFFERENT numbers, both reported', () => {
    const d = detail({ attempt: 2 });
    expect(d.attemptsUsed).toBe(2);
    expect(d.attemptsAllowed).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
  });

  test('a retry-eligible category with attempts left says RETRY-ELIGIBLE - not that one is scheduled', () => {
    // Nothing re-runs a failed task yet, so naming this 'scheduled' would assert an event that never happens.
    expect(detail({ failureCategory: 'provider_error', attempt: 1 }).nextAttempt).toBe('retry_eligible');
  });

  test('a retry-eligible category at the cap says EXHAUSTED, not scheduled', () => {
    // The bound is the point. Showing "scheduled" at the cap would promise an attempt that never comes.
    expect(detail({ failureCategory: 'provider_error', attempt: DEFAULT_RETRY_POLICY.maxAttempts }).nextAttempt).toBe('exhausted');
    expect(detail({ failureCategory: 'provider_error', attempt: 99 }).nextAttempt).toBe('exhausted');
  });

  test('a NON-eligible category says NOT ELIGIBLE — never a remaining count nobody will spend', () => {
    // `policy_blocked` is a decision, not a fault: retrying it would hit the same policy. Showing "2 of 3 attempts
    // used" would invite a founder to wait for a retry that is not coming.
    const d = detail({ failureCategory: 'policy_blocked', attempt: 1 });
    expect(d.nextAttempt).toBe('not_eligible');
  });

  test('a NONSENSE attempt count never produces a nonsense detail', () => {
    // Attempts come from a database column; a negative or absent one should degrade to an honest floor rather than
    // making the arithmetic produce "-4 attempts remaining".
    for (const bad of [0, -3, Number.NaN, undefined, null, '2']) {
      const d = detail({ attempt: bad });
      expect(d.attemptsUsed).toBeGreaterThanOrEqual(1);

    }
  });
});

describe('retry SAFETY defaults to unsafe (G5)', () => {
  test('only the categories canon establishes as idempotent are safe', () => {
    // FAILURE-AND-RECOVERY assigns idempotency per row: a model timeout is a "pure call — safe", a lost worker
    // resumes from checkpointed (idempotent) steps. Anything else is unsafe.
    for (const category of RUN_FAILURE_CATEGORIES) {
      const expected = (RETRY_SAFE_CATEGORIES as readonly string[]).includes(category) ? 'safe' : 'unsafe';
      expect(detail({ failureCategory: category }).retrySafety).toBe(expected);
    }
  });

  test('an UNKNOWN cause is UNSAFE to retry — the direction that cannot double-execute', () => {
    // If we cannot say what went wrong, we certainly cannot say that doing it again is harmless.
    expect(detail({ failureCategory: null }).retrySafety).toBe('unsafe');
  });

  test('the safe set is a SUBSET of the real categories — no phantom entries', () => {
    for (const safe of RETRY_SAFE_CATEGORIES) {
      expect(RUN_FAILURE_CATEGORIES).toContain(safe);
    }
  });
});

describe('the honest-future fixes (review pass 1)', () => {
  test('a MALFORMED policy is EXHAUSTED, matching the retry engine rather than contradicting it', () => {
    // classifyRetryOutcome dead-letters on maxAttempts 0 or Infinity. This module used to substitute the default and
    // report a retry as possible - two boundaries disagreeing about the same run.
    for (const bad of [{ maxAttempts: 0 }, { maxAttempts: Number.POSITIVE_INFINITY }, { maxAttempts: -1 }]) {
      const d = describeRunFailure({ state: 'failed', failureCategory: 'timeout', attempt: 1 }, bad as never);
      expect(d?.nextAttempt).toBe('exhausted');
    }
  });

  test('an attempt count ABOVE the cap reports the TRUE number, not a clamped one', () => {
    // '3 of 3' for a seventh attempt is a wrong number, and it disagreed with the attempt the audit event records.
    const d = describeRunFailure({ state: 'failed', failureCategory: 'timeout', attempt: 7 });
    expect(d?.attemptsUsed).toBe(7);
    expect(d?.nextAttempt).toBe('exhausted');
  });

  test('ONLY timeout is retry-safe - the set is no longer broader than canon establishes', () => {
    expect([...RETRY_SAFE_CATEGORIES]).toEqual(['timeout']);
  });
});