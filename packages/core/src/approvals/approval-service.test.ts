// ACBP-P6-003c — the approval service's PURE parts, tested without a database.
//
// This file exists because of a measured gap: the inbox page clamp was inlined in the use case, and raising its
// ceiling from 200 to a million survived the entire real-PostgreSQL suite. No integration test creates enough
// fixture rows to notice, and creating 201 of them to prove a `Math.min` would be an absurd price. A pure function
// can simply be asked. It is also NOT `skipIf`-gated, so unlike everything else guarding this module it cannot
// vanish silently when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect } from 'vitest';
import { clampInboxLimit, INBOX_MAX_PAGE } from './approval-service.js';

describe('clampInboxLimit — ACBP-P6-003c', () => {
  test('a caller asking for everything gets one page', () => {
    expect(clampInboxLimit(1_000_000)).toBe(INBOX_MAX_PAGE);
    expect(clampInboxLimit(Number.MAX_SAFE_INTEGER)).toBe(INBOX_MAX_PAGE);
    expect(clampInboxLimit(INBOX_MAX_PAGE + 1)).toBe(INBOX_MAX_PAGE);
  });

  test('the ceiling is a real bound, not a formality', () => {
    // Pinning the VALUE, not just the relation: `toBeLessThanOrEqual(ceiling)` passes for any ceiling, which is
    // exactly how the inlined version let a million through unnoticed.
    expect(INBOX_MAX_PAGE).toBe(200);
    expect(clampInboxLimit(INBOX_MAX_PAGE)).toBe(INBOX_MAX_PAGE);
  });

  test('a missing limit is a sane default, not unbounded', () => {
    expect(clampInboxLimit(undefined)).toBe(50);
  });

  test('nonsense does not become "everything" — it becomes the default or the floor', () => {
    // `Number.isFinite` is the guard, so NaN and both infinities fall back rather than propagating into the query.
    expect(clampInboxLimit(Number.NaN)).toBe(50);
    expect(clampInboxLimit(Number.POSITIVE_INFINITY)).toBe(50);
    expect(clampInboxLimit(Number.NEGATIVE_INFINITY)).toBe(50);
    expect(clampInboxLimit(undefined as unknown as number)).toBe(50);
  });

  test('zero and negatives clamp UP to one row, never to "no limit"', () => {
    expect(clampInboxLimit(0)).toBe(1);
    expect(clampInboxLimit(-1)).toBe(1);
    expect(clampInboxLimit(-1_000_000)).toBe(1);
  });
});
