/*
 * ACBP-FE-013 / ACBP-FE-014 — the generate interpreters.
 *
 * THE SIX 409s ARE THE POINT. Each names a different thing the founder must do first, and each is
 * NON-RETRYABLE as-is — so the assertions below check both that they are told apart and that none of them is
 * offered a retry that is guaranteed to fail again.
 */
import { describe, expect, it } from 'vitest';
import { generateNetworkFailure, generateOutcomeFor } from './generate-outcome';

const PRECONDITIONS = ['no_understanding', 'not_confirmed', 'stale_understanding', 'no_decision', 'decision_rejected', 'stale_decision'] as const;

describe('every precondition is a distinct, actionable answer', () => {
  it('each 409 maps to blocked_precondition', () => {
    for (const code of PRECONDITIONS) {
      expect(generateOutcomeFor(409, { error: code }, null, 'strategy').kind, code).toBe('blocked_precondition');
    }
  });

  it('no two produce the same sentence', () => {
    // Collapsing any pair would throw away the only actionable half of the answer.
    const details = PRECONDITIONS.map((c) => generateOutcomeFor(409, { error: c }, null, 'strategy').detail);
    expect(new Set(details).size).toBe(PRECONDITIONS.length);
  });

  it('NONE of them is offered as retryable, because retrying unchanged cannot succeed', () => {
    for (const code of PRECONDITIONS) {
      expect(generateOutcomeFor(409, { error: code }, null, 'strategy').retryable, code).toBe(false);
      expect(generateOutcomeFor(409, { error: code }, null, 'strategy').produced, code).toBe(false);
    }
  });

  it('not_confirmed says CONFIRM, and no_understanding says the interview — they are not interchangeable', () => {
    expect(generateOutcomeFor(409, { error: 'not_confirmed' }, null, 'strategy').detail.toLowerCase()).toContain('confirm');
    expect(generateOutcomeFor(409, { error: 'no_understanding' }, null, 'strategy').detail.toLowerCase()).toContain('interview');
  });

  it('decision_rejected says retrying is futile, because a rejection never unlocks planning', () => {
    expect(generateOutcomeFor(409, { error: 'decision_rejected' }, null, 'roadmap').detail.toLowerCase()).toContain('keep failing');
  });

  it('an UNRECOGNISED 409 is not silently treated as a precondition', () => {
    expect(generateOutcomeFor(409, { error: 'something_new' }, null, 'strategy').kind).toBe('unexpected');
  });
});

describe('502 is the model failing, not the platform', () => {
  it('is retryable and says nothing was recorded', () => {
    const r = generateOutcomeFor(502, { error: 'generation_failed' }, null, 'strategy');
    expect(r.kind).toBe('model_failed');
    expect(r.retryable).toBe(true);
    expect(r.produced).toBe(false);
  });

  it('a 500, by contrast, cannot say whether anything was written', () => {
    const r = generateOutcomeFor(500, { error: 'internal_error' }, null, 'strategy');
    expect(r.produced).toBeNull();
    expect(r.retryable).toBe(false);
  });
});

describe('the company ceiling', () => {
  it('reads Retry-After and says nothing was spent', () => {
    const r = generateOutcomeFor(429, {}, '90', 'strategy');
    expect(r.kind).toBe('rate_limited');
    expect(r.retryAfterSeconds).toBe(90);
    expect(r.detail.toLowerCase()).toContain('nothing was spent');
  });

  it('refuses a non-numeric Retry-After rather than inventing a wait', () => {
    for (const h of ['', 'soon', '-5', '1.5.2']) expect(generateOutcomeFor(429, {}, h, 'strategy').retryAfterSeconds, h).toBeNull();
  });
});

describe('a 403 never implies a cost', () => {
  it('says nothing about credits, because the ceiling is debited only AFTER authorization', () => {
    // ACBP-API-008 head 2046c69 moved the debit after owner-only authz precisely so this is true.
    const d = generateOutcomeFor(403, { error: 'forbidden' }, null, 'strategy').detail.toLowerCase();
    expect(d).not.toContain('credit');
    expect(d).not.toContain('spent');
    expect(d).not.toContain('quota');
  });

  it('an unverified email is not reported as a permission problem', () => {
    expect(generateOutcomeFor(403, { error: 'email_unverified' }, null, 'strategy').kind).toBe('email_unverified');
  });
});

describe('success and unreachable', () => {
  it('200 reports produced', () => {
    expect(generateOutcomeFor(200, { generation: {} }, null, 'strategy').produced).toBe(true);
  });

  it('a request that never arrived tells the founder to RELOAD, not to generate again', () => {
    // Generation is metered: a second attempt is charged separately, so "try again" is the expensive guess.
    const r = generateNetworkFailure('strategy');
    expect(r.produced).toBeNull();
    expect(r.detail.toLowerCase()).toContain('reload');
    expect(r.detail.toLowerCase()).toContain('metered');
  });
});
