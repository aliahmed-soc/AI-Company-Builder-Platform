/*
 * ACBP-FE-007 — the view mapper's rules, especially the two the server will never contradict.
 *
 * `resumeAt` and the empty/end distinction are DERIVATIONS this screen performs over server data. Nothing on
 * the server will ever disagree with them, which is exactly why they need tests: a wrong derivation here
 * produces a screen that looks right and is wrong, with no failing request to reveal it.
 */
import { describe, expect, it } from 'vitest';
import type { QuestionWithAnswerDTO, SessionQADTO, InterviewSessionDTO } from '@acbp/contracts';
import { describeInterview, toInterviewView } from './interview-view';

function question(overrides: {
  id: string;
  position: number;
  lifecycle: 'asked' | 'answered' | 'skipped';
  rationale?: string | null;
  source?: 'adaptive' | 'static_fallback';
  content?: string | null;
  revisions?: number;
}): QuestionWithAnswerDTO {
  const { id, position, lifecycle } = overrides;
  // `rationale` uses an in-check rather than `??` on purpose: `?? null` would silently replace an explicit
  // null with the same null and hide whether the caller meant it. FE-005 shipped that exact bug in a helper.
  const rationale = 'rationale' in overrides ? (overrides.rationale as string | null) : 'Because it matters.';
  const revisionCount = overrides.revisions ?? (lifecycle === 'asked' ? 0 : 1);
  const answer =
    lifecycle === 'asked'
      ? null
      : {
          questionId: id,
          revision: revisionCount,
          status: lifecycle === 'skipped' ? ('skipped' as const) : ('answered' as const),
          content: lifecycle === 'skipped' ? null : ('content' in overrides ? overrides.content : 'An answer.') ?? null,
          createdAt: '2026-08-17T00:00:00.000Z',
        };
  return {
    question: {
      questionId: id,
      position,
      prompt: `Prompt ${id}`,
      rationale,
      source: overrides.source ?? 'adaptive',
      createdAt: '2026-08-17T00:00:00.000Z',
    },
    currentAnswer: answer,
    revisions: answer === null ? [] : Array.from({ length: revisionCount }, (_, i) => ({ ...answer, revision: i + 1 })),
    lifecycle,
  };
}

function session(overrides: Partial<InterviewSessionDTO> = {}): InterviewSessionDTO {
  return {
    sessionId: 'ses_1',
    companyId: 'cmp_1',
    state: 'in_progress',
    phase: 'in_progress',
    startedAt: '2026-08-17T00:00:00.000Z',
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

function qa(items: readonly QuestionWithAnswerDTO[]): SessionQADTO {
  return { sessionId: 'ses_1', items };
}

describe('toInterviewView — where a resumed session lands', () => {
  it('resumes at the lowest-position unanswered question', () => {
    const view = toInterviewView(session(), qa([question({ id: 'q1', position: 1, lifecycle: 'answered' }), question({ id: 'q2', position: 2, lifecycle: 'asked' }), question({ id: 'q3', position: 3, lifecycle: 'asked' })]));
    expect(view.resumeAt?.questionId).toBe('q2');
  });

  it('follows POSITION, not array order, when the two disagree', () => {
    // The contract says items arrive in position order. This asserts the derivation does not DEPEND on that:
    // position is the ordering fact, array order is a convenience. If the server ever reorders, the founder
    // still lands on the earliest genuinely-unanswered question rather than the first one in the array.
    const view = toInterviewView(session(), qa([question({ id: 'late', position: 9, lifecycle: 'asked' }), question({ id: 'early', position: 2, lifecycle: 'asked' })]));
    expect(view.resumeAt?.questionId).toBe('early');
  });

  it('has nowhere to resume when every question has been addressed', () => {
    const view = toInterviewView(session(), qa([question({ id: 'q1', position: 1, lifecycle: 'answered' }), question({ id: 'q2', position: 2, lifecycle: 'skipped' })]));
    expect(view.resumeAt).toBeNull();
  });

  it('treats a SKIPPED question as addressed, not as still-open work', () => {
    // A skip is the "I don't know" answer, not a deferral. Re-offering it as the resume point would loop a
    // founder back onto the question they just told the server they could not answer.
    const view = toInterviewView(session(), qa([question({ id: 'q1', position: 1, lifecycle: 'skipped' }), question({ id: 'q2', position: 2, lifecycle: 'asked' })]));
    expect(view.resumeAt?.questionId).toBe('q2');
  });
});

describe('toInterviewView — an empty session is not a finished one', () => {
  it('reports that no questions exist when the server sent none', () => {
    const view = toInterviewView(session(), qa([]));
    expect(view.questionsState).toBe('none_exist');
  });

  it('reports all-addressed only when questions actually exist', () => {
    const view = toInterviewView(session(), qa([question({ id: 'q1', position: 1, lifecycle: 'answered' })]));
    expect(view.questionsState).toBe('all_addressed');
  });

  it('reports work remaining while any question is still asked', () => {
    const view = toInterviewView(session(), qa([question({ id: 'q1', position: 1, lifecycle: 'answered' }), question({ id: 'q2', position: 2, lifecycle: 'asked' })]));
    expect(view.questionsState).toBe('work_remains');
  });
});

describe('toInterviewView — fields the screen must not invent', () => {
  it('carries a null rationale through as null rather than substituting copy', () => {
    const view = toInterviewView(session(), qa([question({ id: 'q1', position: 1, lifecycle: 'asked', rationale: null })]));
    expect(view.questions[0]?.rationale).toBeNull();
  });

  it('keeps a real rationale verbatim', () => {
    const view = toInterviewView(session(), qa([question({ id: 'q1', position: 1, lifecycle: 'asked', rationale: 'To size the market.' })]));
    expect(view.questions[0]?.rationale).toBe('To size the market.');
  });

  it('marks a static_fallback question as degraded so it cannot render identically to an adaptive one', () => {
    const view = toInterviewView(session(), qa([question({ id: 'q1', position: 1, lifecycle: 'asked', source: 'static_fallback' }), question({ id: 'q2', position: 2, lifecycle: 'asked', source: 'adaptive' })]));
    expect(view.questions[0]?.degraded).toBe(true);
    expect(view.questions[1]?.degraded).toBe(false);
  });

  it('distinguishes answered from skipped rather than collapsing both to "done"', () => {
    const view = toInterviewView(session(), qa([question({ id: 'q1', position: 1, lifecycle: 'answered' }), question({ id: 'q2', position: 2, lifecycle: 'skipped' })]));
    expect(view.questions[0]?.lifecycle).toBe('answered');
    expect(view.questions[1]?.lifecycle).toBe('skipped');
  });

  it('counts revisions from the server history rather than inferring them', () => {
    const view = toInterviewView(session(), qa([question({ id: 'q1', position: 1, lifecycle: 'answered', revisions: 3 })]));
    expect(view.questions[0]?.revisionCount).toBe(3);
  });

  it('counts only answered questions as answered — a skip is addressed but not answered', () => {
    const view = toInterviewView(session(), qa([question({ id: 'q1', position: 1, lifecycle: 'answered' }), question({ id: 'q2', position: 2, lifecycle: 'skipped' }), question({ id: 'q3', position: 3, lifecycle: 'asked' })]));
    expect(view.answeredCount).toBe(1);
    expect(view.addressedCount).toBe(2);
    expect(view.totalCount).toBe(3);
  });
});

describe('toInterviewView — exactly one of pause/resume can ever act', () => {
  it('offers pause and refuses resume while the session is running', () => {
    const view = toInterviewView(session({ state: 'in_progress', phase: 'in_progress' }), qa([]));
    expect(view.pause.kind).toBe('available');
    expect(view.resume.kind).toBe('unavailable');
    expect(view.resume.kind === 'unavailable' && view.resume.because).toBe('already_running');
  });

  it('offers resume and refuses pause while the session is paused', () => {
    const view = toInterviewView(session({ state: 'waiting_for_user', phase: 'awaiting_input' }), qa([]));
    expect(view.resume.kind).toBe('available');
    expect(view.pause.kind).toBe('unavailable');
    expect(view.pause.kind === 'unavailable' && view.pause.because).toBe('already_paused');
  });

  it('refuses both on a phase neither transition is legal from, and names the phase', () => {
    // `confirmed` is a real contract phase. Firing either control from it is a guaranteed 409, so both are
    // disabled — and the reason quotes the server's own phase word rather than a guess at what to do.
    const view = toInterviewView(session({ state: 'confirmed', phase: 'confirmed' }), qa([]));
    expect(view.pause.kind).toBe('unavailable');
    expect(view.resume.kind).toBe('unavailable');
    expect(view.pause.kind === 'unavailable' && view.pause.reason).toContain('confirmed');
  });

  it('refuses both on an unrecognised phase instead of assuming a healthy one', () => {
    const view = toInterviewView(session({ state: 'in_progress', phase: 'unknown' }), qa([]));
    expect(view.pause.kind).toBe('unavailable');
    expect(view.resume.kind).toBe('unavailable');
  });
});

describe('describeInterview — the politely-announced sentence', () => {
  it('is identical for identical server state, which is what stops it re-announcing on every poll', () => {
    // The live region re-announces whenever its text CHANGES. The no-repeat behaviour is therefore a property
    // of this function being pure over server state — not of the ref that guards it.
    const input = qa([question({ id: 'q1', position: 1, lifecycle: 'answered' }), question({ id: 'q2', position: 2, lifecycle: 'asked' })]);
    expect(describeInterview(toInterviewView(session(), input))).toBe(describeInterview(toInterviewView(session(), input)));
  });

  it('uses the number of questions that exist as the denominator', () => {
    const view = toInterviewView(session(), qa([question({ id: 'q1', position: 1, lifecycle: 'answered' }), question({ id: 'q2', position: 2, lifecycle: 'asked' })]));
    expect(describeInterview(view)).toContain('of 2');
  });

  it('never calls an empty session finished', () => {
    // The whole point of the empty/end split. On this build a founder ALWAYS sees this state, because no
    // route can generate a question — so this is the sentence most likely to be read, and a "you're done"
    // here would be the screen's single biggest lie.
    const sentence = describeInterview(toInterviewView(session(), qa([]))).toLowerCase();
    expect(sentence).not.toContain('finished');
    expect(sentence).not.toContain('done');
    expect(sentence).not.toContain('complete');
  });

  it('says every existing question is addressed without implying the interview is over', () => {
    const sentence = describeInterview(toInterviewView(session(), qa([question({ id: 'q1', position: 1, lifecycle: 'answered' })]))).toLowerCase();
    expect(sentence).not.toContain('interview is over');
    // Both numbers, and the denominator is the count of questions that EXIST — the only one the server sends.
    expect(sentence).toContain('1 answered of 1');
  });
});
