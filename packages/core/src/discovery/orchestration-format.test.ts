// @acbp/core — formatPriorAnswers unit tests (ACBP-P2-005; DISC-002). Pure. Builds the bounded prior-answers
// prompt text from the session Q&A: answered questions only, optional exclusion, and an honest empty marker.
import { describe, test, expect } from 'vitest';
import type { SessionQADTO } from '@acbp/contracts';
import { formatPriorAnswers } from './orchestration.js';

function qa(items: Array<{ questionId: string; prompt: string; answer: string | null; status?: 'answered' | 'skipped' }>): SessionQADTO {
  return {
    sessionId: 's1',
    items: items.map((i) => ({
      question: { questionId: i.questionId, position: 1, prompt: i.prompt, rationale: null, source: 'adaptive', createdAt: '2026-01-01T00:00:00.000Z' },
      currentAnswer: i.answer === null ? null : { questionId: i.questionId, revision: 1, status: i.status ?? 'answered', content: i.answer, createdAt: '2026-01-01T00:00:00.000Z' },
      revisions: [],
      lifecycle: i.answer === null ? 'unanswered' : (i.status ?? 'answered'),
    })),
  };
}

describe('formatPriorAnswers (DISC-002)', () => {
  test('includes answered questions with their content, in Q/A form', () => {
    const text = formatPriorAnswers(qa([{ questionId: 'q1', prompt: 'What do you sell?', answer: 'Coffee.' }]));
    expect(text).toContain('What do you sell?');
    expect(text).toContain('Coffee.');
  });
  test('omits unanswered and skipped questions', () => {
    const text = formatPriorAnswers(qa([
      { questionId: 'q1', prompt: 'A?', answer: 'yes' },
      { questionId: 'q2', prompt: 'B?', answer: null },
      { questionId: 'q3', prompt: 'C?', answer: null, status: 'skipped' },
    ]));
    expect(text).toContain('A?');
    expect(text).not.toContain('B?');
    expect(text).not.toContain('C?');
  });
  test('excludes a named question (the one being evaluated)', () => {
    const text = formatPriorAnswers(qa([{ questionId: 'q1', prompt: 'A?', answer: 'x' }, { questionId: 'q2', prompt: 'B?', answer: 'y' }]), 'q2');
    expect(text).toContain('A?');
    expect(text).not.toContain('B?');
  });
  test('an empty session yields an honest marker (not a blank prompt)', () => {
    expect(formatPriorAnswers(qa([]))).toBe('No prior answers yet.');
  });
});
