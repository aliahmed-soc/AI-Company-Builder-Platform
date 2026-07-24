// @acbp/database — interview Q&A repository (ACBP-P2-002; CDR-023).
//
// Operates on the immutable `interview_questions` and append-only `interview_answers` rows. Takes a plain
// executor and relies on the caller to run it under the correct RLS scope — every method requires a validated
// COMPANY scope (the dual-keyed policies deny anything else). Kysely parameterized queries only; no raw SQL
// interpolation. There is deliberately NO update/delete method: a question never changes, and an answer
// revision is always a NEW row (the (question_id, revision) PK + `ON CONFLICT DO NOTHING` handle concurrency).
import type { Kysely } from 'kysely';
import type { DatabaseSchema, InterviewQuestionRow, InterviewAnswerRow } from './schema.js';

export type InterviewQaExecutor = Kysely<DatabaseSchema>;

export class InterviewQaRepository {
  readonly #db: InterviewQaExecutor;
  constructor(db: InterviewQaExecutor) {
    this.#db = db;
  }

  /** The next position for a session's questions (max + 1, or 1 for the first). RLS confines to the scope. */
  async nextQuestionPosition(sessionId: string): Promise<number> {
    const r = await this.#db.selectFrom('interview_questions').select((eb) => eb.fn.max('position').as('maxpos')).where('session_id', '=', sessionId).executeTakeFirst();
    const max = r?.maxpos;
    return (typeof max === 'number' ? max : 0) + 1;
  }

  /** Insert an immutable question at `position`. The `(session_id, position)` unique constraint rejects a slot
   *  collision (a concurrent add at the same computed position → the loser retries at the caller's discretion).
   *  `rationale` (the "why we ask", DISC-006) and `source` ('adaptive' | 'static_fallback', DISC-002 — migration
   *  0018) are optional: omitting `source` applies the DB default 'adaptive'; omitting `rationale` stores null. */
  insertQuestion(accountId: string, companyId: string, sessionId: string, position: number, prompt: string, rationale?: string | null, source?: string): Promise<InterviewQuestionRow> {
    return this.#db
      .insertInto('interview_questions')
      .values({
        account_id: accountId,
        company_id: companyId,
        session_id: sessionId,
        position,
        prompt,
        ...(rationale !== undefined ? { rationale } : {}),
        ...(source !== undefined ? { source } : {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** A session's questions in position order (RLS-confined). */
  listQuestions(sessionId: string): Promise<InterviewQuestionRow[]> {
    return this.#db.selectFrom('interview_questions').selectAll().where('session_id', '=', sessionId).orderBy('position', 'asc').execute();
  }

  /** A single question by id (RLS-confined; undefined when absent/invisible). */
  findQuestion(questionId: string): Promise<InterviewQuestionRow | undefined> {
    return this.#db.selectFrom('interview_questions').selectAll().where('id', '=', questionId).executeTakeFirst();
  }

  /** A question's answer revisions in ascending revision order (the full retained history). */
  listAnswers(questionId: string): Promise<InterviewAnswerRow[]> {
    return this.#db.selectFrom('interview_answers').selectAll().where('question_id', '=', questionId).orderBy('revision', 'asc').execute();
  }

  /** ALL answer revisions for a session (for building the Q&A view in one read), ascending by question+revision. */
  listAnswersForSession(sessionId: string): Promise<InterviewAnswerRow[]> {
    return this.#db.selectFrom('interview_answers').selectAll().where('session_id', '=', sessionId).orderBy('question_id', 'asc').orderBy('revision', 'asc').execute();
  }

  /** The current (highest-revision) answer for a question, or undefined when unanswered. */
  currentAnswer(questionId: string): Promise<InterviewAnswerRow | undefined> {
    return this.#db.selectFrom('interview_answers').selectAll().where('question_id', '=', questionId).orderBy('revision', 'desc').limit(1).executeTakeFirst();
  }

  /**
   * Append an answer revision. `ON CONFLICT (question_id, revision) DO NOTHING` makes a concurrent write at the
   * same computed revision graceful — the loser inserts nothing and returns `undefined`, and the caller re-reads
   * the current answer. `content` is NULL for a skip. Returns the inserted row, or `undefined` on a race.
   */
  async appendAnswer(input: { accountId: string; companyId: string; sessionId: string; questionId: string; revision: number; status: string; content: string | null; authorUserId: string }): Promise<InterviewAnswerRow | undefined> {
    return this.#db
      .insertInto('interview_answers')
      .values({
        question_id: input.questionId,
        revision: input.revision,
        session_id: input.sessionId,
        account_id: input.accountId,
        company_id: input.companyId,
        status: input.status,
        content: input.content,
        created_by_user_id: input.authorUserId,
      })
      .onConflict((oc) => oc.columns(['question_id', 'revision']).doNothing())
      .returningAll()
      .executeTakeFirst();
  }
}
