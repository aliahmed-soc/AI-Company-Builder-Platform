/*
 * ACBP-FE-007 — turning the two interview reads into one thing the screen can render.
 *
 * PURE ON PURPOSE, like `provisioning-view.ts` beside it. The page is a server component and there are no
 * Clerk keys in this environment, so anything not in a module like this one is effectively unverified.
 *
 * THIS FILE OWNS TWO DERIVATIONS THE SERVER WILL NEVER CONTRADICT, which is precisely why they are here and
 * tested rather than inline in a component:
 *
 *  1. WHERE A RESUMED SESSION LANDS. There is no server cursor. The `interview_sessions` table (migration
 *     0012) carries id, account_id, company_id, state, started_at, created_at, updated_at, and NONE of them
 *     is a current-question id, index or pointer. `InterviewSessionDTO` is not a mirror of that row — it
 *     redacts `account_id` and adds the derived `phase` — but it likewise carries no pointer. Suspend and
 *     resume preserve the session row and its append-only answers, nothing more. So "a suspended session
 *     resumes at the same question" is satisfied HERE, as the earliest question by `position` that is still
 *     `asked`. That is a derivation over two server-supplied fields, so it is honest — but it is THIS
 *     SCREEN'S RULE, not a guarantee the server makes, and no field exists to show if a founder asks "which
 *     question was I on".
 *
 *  2. WHETHER AN EMPTY LIST MEANS FINISHED. It does not — and, added after review, whether a list was READ
 *     AT ALL is a third state that must not collapse into either. `SessionQADTO.items` carries EVERY
 *     question ever asked in the session regardless of lifecycle (built by `getSessionQa` in core
 *     interview-qa.ts), so an empty list means no question has ever been generated. That is a different fact
 *     from "all of them are answered", and BOTH are different from "nobody has successfully asked".
 *
 *     THE `unknown` ARM EXISTS BECAUSE THE FIRST VERSION OF THIS SCREEN GOT IT WRONG. The component passed
 *     `qa ?? { items: [] }`, so a FAILED read rendered as a positive server assertion that no questions
 *     exist — and the polite live region announced it, where no error banner exists to contradict it. An
 *     independent review found it. Taking `SessionQADTO | null` here, rather than letting a caller
 *     substitute an empty list, makes that mistake unrepresentable instead of merely discouraged.
 *
 * `position` IS THE ORDERING FACT; ARRAY ORDER IS A CONVENIENCE. The contract documents `items` as arriving
 * in `position` order, and the display renders them in the order given. The resume derivation deliberately
 * does not depend on that promise — it reads `position` — so a server-side reordering could never silently
 * send a founder back to a question they had already passed.
 */
import type { InterviewDisplayPhase, InterviewSessionDTO, InterviewSessionState, QuestionLifecycle, QuestionSource, QuestionWithAnswerDTO, SessionQADTO } from '@acbp/contracts';

export interface QuestionCardView {
  readonly questionId: string;
  readonly position: number;
  readonly prompt: string;
  /**
   * The server's "why we ask" (DISC-006), or null. NULL IS RENDERED AS ABSENCE, never as placeholder copy:
   * `QuestionDTO.rationale` is `string | null` because legacy and manually-seeded questions genuinely have
   * no rationale, and inventing a sentence there would be this screen claiming the model explained itself
   * when it did not.
   */
  readonly rationale: string | null;
  readonly source: QuestionSource;
  /**
   * True when the server flagged this question as coming from the static fallback bank rather than the model
   * — the flag the backend added so a founder can SEE that generation degraded (INTERVIEW.md:130-132).
   * Rendering a fallback question identically to an adaptive one would discard the only honest signal of a
   * model outage that reaches the client.
   */
  readonly degraded: boolean;
  readonly lifecycle: QuestionLifecycle;
  /** The current answer's text; null for an unanswered question AND for a skip (a skip records no content). */
  readonly answerText: string | null;
  /** From the server's append-only history. `> 1` means the founder really did revise it. */
  readonly revisionCount: number;
}

/** Available, or unavailable with a machine-readable cause AND a sentence — never one without the other. */
export type ControlAvailability = { readonly kind: 'available' } | { readonly kind: 'unavailable'; readonly because: string; readonly reason: string };

/**
 * Four states, no two of which may share copy. See the header.
 *
 * `unknown` — nobody has successfully read the list. Claims NOTHING about whether questions exist.
 * `none_exist` — the server returned a list and it was empty. An absence the server actually stated.
 * `all_addressed` — every question that exists has been answered or skipped.
 * `work_remains` — at least one question is still `asked`.
 */
export type QuestionsState = 'unknown' | 'none_exist' | 'all_addressed' | 'work_remains';

export interface InterviewView {
  readonly sessionId: string;
  readonly state: InterviewSessionState;
  readonly phase: InterviewDisplayPhase;
  readonly questions: readonly QuestionCardView[];
  /** Where a resumed session lands; null when nothing is still `asked`. See the header. */
  readonly resumeAt: QuestionCardView | null;
  readonly questionsState: QuestionsState;
  /** Questions with a real answer. A SKIP IS NOT ONE — it is addressed, but nothing was answered. */
  readonly answeredCount: number;
  /** Questions the founder has dealt with either way (answered or skipped). */
  readonly addressedCount: number;
  /** The only denominator that exists. The server sends no total, so nothing else could be honest. */
  readonly totalCount: number;
  readonly pause: ControlAvailability;
  readonly resume: ControlAvailability;
}

function toCard(item: QuestionWithAnswerDTO): QuestionCardView {
  return {
    questionId: item.question.questionId,
    position: item.question.position,
    prompt: item.question.prompt,
    rationale: item.question.rationale,
    source: item.question.source,
    degraded: item.question.source === 'static_fallback',
    lifecycle: item.lifecycle,
    answerText: item.currentAnswer?.content ?? null,
    revisionCount: item.revisions.length,
  };
}

/**
 * AT MOST one of pause/resume can act, and on most phases NEITHER can — five of the seven arms below
 * disable both. (The first version of this comment said "exactly one", which is false for those five and
 * was contradicted by the tests directly under it.)
 *
 * Both transitions are server-enforced against `LEGAL_TRANSITIONS` in contracts `interview.ts`, so firing
 * the wrong one is a guaranteed 409 — a control that cannot act. The disabled one therefore carries its
 * reason as TEXT, per the rule stated on `.cs-control-why` in console.css: a hover-only explanation is
 * unreachable by touch and by keyboard, which makes the explanation decorative.
 *
 * The phases below `awaiting_input` are all currently unreachable — nothing in the repository writes
 * `ready_for_review`, `confirmed` or `superseded`, and `insertStartedIfAbsent` mints a session directly in
 * `in_progress` so `not_started` never appears either. They are handled anyway, because unlike the
 * provisioning stepper's absent `running` tone (whose status the contract explicitly refuses to commit),
 * the contract DOES commit all seven of these phases. Handling a committed value is not speculation.
 */
function controls(phase: InterviewDisplayPhase): { pause: ControlAvailability; resume: ControlAvailability } {
  switch (phase) {
    case 'in_progress':
      return {
        pause: { kind: 'available' },
        resume: { kind: 'unavailable', because: 'already_running', reason: 'This session is already running, so there is nothing to resume.' },
      };
    case 'awaiting_input':
      return {
        pause: { kind: 'unavailable', because: 'already_paused', reason: 'This session is already paused, so there is nothing to pause.' },
        resume: { kind: 'available' },
      };
    case 'not_started':
    case 'in_review':
    case 'confirmed':
    case 'superseded': {
      // Quotes the server's phase rather than guessing a next step: the legal map allows no pause or resume
      // from any of these, and the response would say so with a 409 carrying this same word.
      const reason = `The server reports this session as "${phase}", and neither pausing nor resuming is a move it allows from there.`;
      return { pause: { kind: 'unavailable', because: phase, reason }, resume: { kind: 'unavailable', because: phase, reason } };
    }
    case 'unknown':
    default: {
      // `unknown` is a REAL arm the server produces on purpose for an unrecognised state — "NEVER a
      // fabricated healthy phase" (contracts interview.ts:74). Treating it as running would be exactly the
      // fabrication that projection exists to prevent.
      const reason = 'The server reported a session state this screen does not recognise, so neither control is offered rather than guessing which would be accepted.';
      return { pause: { kind: 'unavailable', because: 'unknown', reason }, resume: { kind: 'unavailable', because: 'unknown', reason } };
    }
  }
}

/**
 * `qa` is nullable ON PURPOSE and callers must NOT substitute an empty list for a missing read — that
 * substitution is the defect the `unknown` arm exists to make unrepresentable. See the header.
 */
export function toInterviewView(session: InterviewSessionDTO, qa: SessionQADTO | null): InterviewView {
  const questions = (qa?.items ?? []).map(toCard);

  // Lowest `position` among the still-asked, computed rather than taken from array order. See the header.
  let resumeAt: QuestionCardView | null = null;
  for (const card of questions) {
    if (card.lifecycle !== 'asked') continue;
    if (resumeAt === null || card.position < resumeAt.position) resumeAt = card;
  }

  const answeredCount = questions.filter((q) => q.lifecycle === 'answered').length;
  const addressedCount = questions.filter((q) => q.lifecycle !== 'asked').length;

  // `qa === null` is checked FIRST and separately from `questions.length === 0`: an unread list and an
  // empty one are different facts, and only the second is something the server said.
  const questionsState: QuestionsState = qa === null ? 'unknown' : questions.length === 0 ? 'none_exist' : resumeAt === null ? 'all_addressed' : 'work_remains';

  const { pause, resume } = controls(session.phase);

  return {
    sessionId: session.sessionId,
    state: session.state,
    phase: session.phase,
    questions,
    resumeAt,
    questionsState,
    answeredCount,
    addressedCount,
    totalCount: questions.length,
    pause,
    resume,
  };
}

/**
 * The one short sentence the polite live region announces.
 *
 * PURE OVER SERVER STATE, AND THAT IS THE MECHANISM — not a nicety. The live region re-announces when its
 * text CHANGES, so "announce only on movement" is achieved by this function returning an IDENTICAL string
 * when nothing moved. A timestamp, a fetch counter or anything else that varies per render would make the
 * region speak on every poll no matter what guard the component puts around it.
 *
 * IT ALSO LEADS WITH THE SAME QUANTITY THE VISIBLE BADGE SHOWS. Review found the badge counting `addressed`
 * while this counted `answered` — quantities that diverge the moment anyone skips a question — so a
 * screen-reader user and a sighted user were given different numbers for the same interview. Both now lead
 * with `addressed`. `answered` is still reported, because "addressed but not answered" is exactly what a
 * skip is and dropping it would discard the "I don't know" signal.
 */
export function describeInterview(view: InterviewView): string {
  switch (view.questionsState) {
    case 'unknown':
      // Asserts NO absence. The list has not been read, so nothing is known about what it holds.
      return 'The question list has not been read yet, so it is not known whether this interview has any questions.';
    case 'none_exist':
      // Deliberately contains no word for completion. This is the state a founder always reaches on this
      // build, and calling it "finished" would be the screen's largest lie.
      return 'There are no questions in this interview yet.';
    case 'all_addressed':
      return `Every question so far has been addressed: ${String(view.addressedCount)} of ${String(view.totalCount)}, of which ${String(view.answeredCount)} were answered and the rest skipped.`;
    case 'work_remains':
    default:
      return `${String(view.addressedCount)} of ${String(view.totalCount)} questions addressed so far, of which ${String(view.answeredCount)} were answered.`;
  }
}
