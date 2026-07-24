// ACBP-P2-009 — unit tests for the understanding review + confirmation pure contract (CDR-030; UNDER-003/004).
import { describe, test, expect } from 'vitest';
import {
  REVIEW_DECISIONS,
  isReviewDecision,
  CONFIRMATION_EVENT_KINDS,
  isConfirmationEventKind,
  reviewDecisionRequiresNote,
  validateReviewNote,
  isExpectedVersionCurrent,
  isVersionConfirmed,
  REVIEW_NOTE_MAX,
  type ConfirmationEventLike,
} from './review.js';

describe('review decision enum', () => {
  test('the closed 5-control set is exactly the diagram-04 controls', () => {
    expect([...REVIEW_DECISIONS]).toEqual(['approved', 'edited', 'rejected', 'evidence_requested', 'research_requested']);
  });
  test('isReviewDecision is a deny-by-default guard', () => {
    for (const d of REVIEW_DECISIONS) expect(isReviewDecision(d)).toBe(true);
    for (const bad of ['approve', 'APPROVED', '', 'confirmed', 42, null, undefined, {}]) expect(isReviewDecision(bad)).toBe(false);
  });
});

describe('confirmation event kind enum', () => {
  test('the closed lifecycle set is exactly confirmed|corrected', () => {
    expect([...CONFIRMATION_EVENT_KINDS]).toEqual(['confirmed', 'corrected']);
  });
  test('isConfirmationEventKind is a deny-by-default guard', () => {
    expect(isConfirmationEventKind('confirmed')).toBe(true);
    expect(isConfirmationEventKind('corrected')).toBe(true);
    for (const bad of ['superseded', 'generated', '', 1, null, undefined]) expect(isConfirmationEventKind(bad)).toBe(false);
  });
});

describe('reviewDecisionRequiresNote', () => {
  test('only edit requires the corrected text', () => {
    expect(reviewDecisionRequiresNote('edited')).toBe(true);
    for (const d of ['approved', 'rejected', 'evidence_requested', 'research_requested'] as const) {
      expect(reviewDecisionRequiresNote(d)).toBe(false);
    }
  });
});

describe('validateReviewNote', () => {
  test('edit requires a non-blank bounded note (the corrected text)', () => {
    expect(validateReviewNote('edited', 'corrected content')).toEqual({ ok: true, note: 'corrected content' });
    expect(validateReviewNote('edited', '   ')).toEqual({ ok: false });
    expect(validateReviewNote('edited', null)).toEqual({ ok: false });
    expect(validateReviewNote('edited', undefined)).toEqual({ ok: false });
    expect(validateReviewNote('edited', 'x'.repeat(REVIEW_NOTE_MAX + 1))).toEqual({ ok: false });
  });
  test('a note is trimmed', () => {
    expect(validateReviewNote('edited', '  hi  ')).toEqual({ ok: true, note: 'hi' });
  });
  test('non-edit decisions accept an optional note or none', () => {
    expect(validateReviewNote('rejected', 'too speculative')).toEqual({ ok: true, note: 'too speculative' });
    expect(validateReviewNote('rejected', null)).toEqual({ ok: true, note: null });
    expect(validateReviewNote('approved', undefined)).toEqual({ ok: true, note: null });
    expect(validateReviewNote('evidence_requested', '   ')).toEqual({ ok: true, note: null });
    expect(validateReviewNote('research_requested', 'x'.repeat(REVIEW_NOTE_MAX + 1))).toEqual({ ok: false });
  });
});

describe('isExpectedVersionCurrent (optimistic concurrency)', () => {
  test('true only when the expected integer version equals the current version', () => {
    expect(isExpectedVersionCurrent(3, 3)).toBe(true);
    expect(isExpectedVersionCurrent(2, 3)).toBe(false);
    expect(isExpectedVersionCurrent(4, 3)).toBe(false);
  });
  test('non-integer / non-number expected versions are rejected', () => {
    expect(isExpectedVersionCurrent(3.5, 3)).toBe(false);
    expect(isExpectedVersionCurrent('3', 3)).toBe(false);
    expect(isExpectedVersionCurrent(null, 3)).toBe(false);
    expect(isExpectedVersionCurrent(undefined, 3)).toBe(false);
    expect(isExpectedVersionCurrent(Number.NaN, 3)).toBe(false);
  });
});

describe('isVersionConfirmed (the strategy-unlock gate)', () => {
  const ev = (kind: 'confirmed' | 'corrected'): ConfirmationEventLike => ({ kind });
  test('no events → not confirmed (deny-by-default; planning blocked)', () => {
    expect(isVersionConfirmed([])).toBe(false);
  });
  test('a confirmed event with no correction → confirmed (strategy unlocked)', () => {
    expect(isVersionConfirmed([ev('confirmed')])).toBe(true);
  });
  test('a correction supersedes the confirmation → not confirmed (dependents flagged)', () => {
    expect(isVersionConfirmed([ev('confirmed'), ev('corrected')])).toBe(false);
    expect(isVersionConfirmed([ev('corrected'), ev('confirmed')])).toBe(false);
  });
  test('a correction without a confirmation → not confirmed', () => {
    expect(isVersionConfirmed([ev('corrected')])).toBe(false);
  });
});
