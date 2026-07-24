// @acbp/database — interview session repository (ACBP-P2-001; CDR-022).
//
// Operates on the durable `interview_sessions` rows. Like the other repositories it takes a plain executor and
// relies on the caller to run it under the correct RLS scope — every method requires a validated COMPANY scope
// (the dual-keyed policies deny anything else). Kysely parameterized queries only; no raw SQL interpolation.
//
// The repository is deliberately state-machine-agnostic: it persists rows and performs GUARDED updates (the
// `from`-state predicate is part of the UPDATE), but the legality of a transition is decided by @acbp/core
// against the @acbp/contracts transition map before it calls `transition`. The guard here is the concurrency
// backstop (optimistic: the UPDATE only fires when the row is still in the expected `from` state).
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema, InterviewSessionRow } from './schema.js';

export type InterviewExecutor = Kysely<DatabaseSchema>;

export class InterviewSessionRepository {
  readonly #db: InterviewExecutor;
  constructor(db: InterviewExecutor) {
    this.#db = db;
  }

  /**
   * Insert a new session in `in_progress` with `started_at = now()` (the not_started→in_progress entry applied
   * atomically at creation — CDR-022 §2), UNLESS the company already has an open (non-superseded) session. The
   * `ON CONFLICT ... DO NOTHING` targets the partial unique index, so a concurrent first-start does not raise a
   * 23505: the loser simply inserts nothing and gets `undefined`, and the caller returns the existing open
   * session (created: false) — graceful idempotency even under a race. Returns the inserted row, or `undefined`
   * when an open session already existed.
   */
  async insertStartedIfAbsent(accountId: string, companyId: string): Promise<InterviewSessionRow | undefined> {
    return this.#db
      .insertInto('interview_sessions')
      .values({ account_id: accountId, company_id: companyId, state: 'in_progress', started_at: sql<Date>`now()` })
      .onConflict((oc) => oc.column('company_id').where('state', '<>', 'superseded').doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /** The single OPEN (non-superseded) session for a company, or undefined. RLS confines to the current scope. */
  findOpen(companyId: string): Promise<InterviewSessionRow | undefined> {
    return this.#db.selectFrom('interview_sessions').selectAll().where('company_id', '=', companyId).where('state', '!=', 'superseded').executeTakeFirst();
  }

  /** A session by id (RLS-confined to the current company scope). */
  findById(sessionId: string): Promise<InterviewSessionRow | undefined> {
    return this.#db.selectFrom('interview_sessions').selectAll().where('id', '=', sessionId).executeTakeFirst();
  }

  /**
   * Guarded state transition: move `sessionId` from `fromState` to `toState`, atomically in the caller's
   * transaction. The `from`-state predicate is the optimistic concurrency backstop — the UPDATE fires only when
   * the row is still in `fromState`, so a racing transition cannot double-apply. Returns the number of rows
   * updated (0 = the row was not in `fromState`; the caller treats that as an invalid/again transition).
   */
  async transition(sessionId: string, fromState: string, toState: string): Promise<number> {
    const r = await this.#db
      .updateTable('interview_sessions')
      .set({ state: toState, updated_at: sql<Date>`now()` })
      .where('id', '=', sessionId)
      .where('state', '=', fromState)
      .executeTakeFirst();
    return Number(r.numUpdatedRows);
  }
}
