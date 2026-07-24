// @acbp/contracts — Q&A persistence contract tests (ACBP-P2-002; CDR-023). Pure — no IO. Pins the closed
// answer-status set, the bounded submission validation (answered needs content; skipped forbids it), and the
// pure derivations (current revision, next revision, lifecycle, idempotent no-op detection).
import { describe, test, expect } from 'vitest';
import {
  ANSWER_STATUSES,
  ANSWER_CONTENT_MAX,
  isAnswerStatus,
  validateAnswerSubmission,
  currentRevision,
  nextRevision,
  deriveQuestionLifecycle,
  isSameAnswer,
  type AnswerSubmission,
} from './index.js';

describe('answer statuses', () => {
  test('the closed set is exactly answered|skipped', () => {
    expect(ANSWER_STATUSES).toEqual(['answered', 'skipped']);
    for (const s of ANSWER_STATUSES) expect(isAnswerStatus(s)).toBe(true);
    for (const bad of ['answer', 'skip', 'unknown', '', 42, null, undefined, {}]) expect(isAnswerStatus(bad)).toBe(false);
  });
});

describe('validateAnswerSubmission', () => {
  test('an answered submission requires non-empty, bounded content', () => {
    expect(validateAnswerSubmission({ status: 'answered', content: 'hello' })).toEqual({ ok: true, value: { status: 'answered', content: 'hello' } });
    expect(validateAnswerSubmission({ status: 'answered', content: '' }).ok).toBe(false);
    expect(validateAnswerSubmission({ status: 'answered' }).ok).toBe(false);
    expect(validateAnswerSubmission({ status: 'answered', content: 42 }).ok).toBe(false);
    expect(validateAnswerSubmission({ status: 'answered', content: 'x'.repeat(ANSWER_CONTENT_MAX + 1) }).ok).toBe(false);
    expect(validateAnswerSubmission({ status: 'answered', content: 'x'.repeat(ANSWER_CONTENT_MAX) }).ok).toBe(true);
  });

  test('content is verbatim — leading/trailing whitespace is preserved (not trimmed away)', () => {
    const r = validateAnswerSubmission({ status: 'answered', content: '  spaced  ' });
    expect(r.ok && r.value.content).toBe('  spaced  ');
  });

  test('a skipped submission forbids content', () => {
    expect(validateAnswerSubmission({ status: 'skipped' })).toEqual({ ok: true, value: { status: 'skipped', content: null } });
    expect(validateAnswerSubmission({ status: 'skipped', content: null })).toEqual({ ok: true, value: { status: 'skipped', content: null } });
    expect(validateAnswerSubmission({ status: 'skipped', content: 'x' }).ok).toBe(false);
  });

  test('an invalid status is rejected', () => {
    for (const bad of ['nope', '', 42, null, undefined]) expect(validateAnswerSubmission({ status: bad, content: 'x' }).ok).toBe(false);
  });

  test('a validation failure carries a bounded public envelope (no internal detail)', () => {
    const r = validateAnswerSubmission({ status: 'answered', content: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.category).toBe('validation');
      expect(typeof r.error.code).toBe('string');
    }
  });
});

describe('revision derivations', () => {
  const revs = [{ revision: 1 }, { revision: 3 }, { revision: 2 }];
  test('currentRevision returns the highest revision regardless of input order; null for empty', () => {
    expect(currentRevision(revs)?.revision).toBe(3);
    expect(currentRevision([])).toBeNull();
    expect(currentRevision([{ revision: 1 }])?.revision).toBe(1);
  });
  test('nextRevision is max+1, or 1 for the first answer', () => {
    expect(nextRevision([])).toBe(1);
    expect(nextRevision(revs)).toBe(4);
    expect(nextRevision([{ revision: 5 }])).toBe(6);
  });
});

describe('deriveQuestionLifecycle', () => {
  test('null → asked; answered → answered; skipped → skipped', () => {
    expect(deriveQuestionLifecycle(null)).toBe('asked');
    expect(deriveQuestionLifecycle({ status: 'answered' })).toBe('answered');
    expect(deriveQuestionLifecycle({ status: 'skipped' })).toBe('skipped');
  });
});

describe('isSameAnswer (idempotent no-op detection)', () => {
  const answered: AnswerSubmission = { status: 'answered', content: 'hello' };
  const skipped: AnswerSubmission = { status: 'skipped', content: null };
  test('no current answer is never "same"', () => {
    expect(isSameAnswer(null, answered)).toBe(false);
    expect(isSameAnswer(null, skipped)).toBe(false);
  });
  test('identical status + content is the same (idempotent no-op)', () => {
    expect(isSameAnswer({ status: 'answered', content: 'hello' }, answered)).toBe(true);
    expect(isSameAnswer({ status: 'skipped', content: null }, skipped)).toBe(true);
  });
  test('different content or status is a genuine revision', () => {
    expect(isSameAnswer({ status: 'answered', content: 'world' }, answered)).toBe(false);
    expect(isSameAnswer({ status: 'skipped', content: null }, answered)).toBe(false);
    expect(isSameAnswer({ status: 'answered', content: 'hello' }, skipped)).toBe(false);
  });
});
