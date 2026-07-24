// @acbp/database — understanding review + confirmation repository (ACBP-P2-009; CDR-030 §5/§6).
//
// Operates on the append-only `understanding_item_reviews` + `understanding_confirmation_events` rows. Takes a plain
// executor and relies on the caller to run it under the correct COMPANY scope (the dual-keyed policies deny anything
// else); the use case writes the review/confirmation event + its audit event in ONE transaction. Kysely
// parameterized queries only; no raw SQL interpolation. There is deliberately NO update/delete method — the log is
// append-only; a supersession is a NEW event row, never a destructive edit.
import type { Kysely } from 'kysely';
import type { DatabaseSchema, UnderstandingItemReviewRow, UnderstandingConfirmationEventRow } from './schema.js';

export type UnderstandingReviewExecutor = Kysely<DatabaseSchema>;

/** The fields a caller supplies to record one item review decision (identity is server-set upstream). */
export interface NewUnderstandingItemReviewInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly documentId: string;
  readonly itemId: string;
  readonly decision: string;
  readonly note: string | null;
  readonly decidedByUserId: string;
}

/** The fields a caller supplies to record one confirmation-lifecycle event. */
export interface NewUnderstandingConfirmationEventInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly documentId: string;
  readonly version: number;
  readonly kind: string;
  readonly actorUserId: string;
  readonly correctionRef: string | null;
  readonly dependentsFlagged: number | null;
}

export class UnderstandingReviewRepository {
  readonly #db: UnderstandingReviewExecutor;
  constructor(db: UnderstandingReviewExecutor) {
    this.#db = db;
  }

  /** Record one item review decision (append-only). RLS confines the write to the caller's company scope. */
  insertReview(input: NewUnderstandingItemReviewInput): Promise<UnderstandingItemReviewRow> {
    return this.#db
      .insertInto('understanding_item_reviews')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        document_id: input.documentId,
        item_id: input.itemId,
        decision: input.decision,
        note: input.note,
        decided_by_user_id: input.decidedByUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * The review decisions of a document version (RLS-confined), chronological (oldest → newest) so a consumer may
   * take the LAST row as an item's effective decision. Ordered by `created_at` (the insertion clock) with `id` as a
   * deterministic tiebreak for same-instant rows — NOT by `id` alone, which is a random UUID (not time-ordered).
   */
  listReviews(documentId: string): Promise<UnderstandingItemReviewRow[]> {
    return this.#db.selectFrom('understanding_item_reviews').selectAll().where('document_id', '=', documentId).orderBy('created_at', 'asc').orderBy('id', 'asc').execute();
  }

  /**
   * Record one confirmation-lifecycle event. `ON CONFLICT (document_id, kind) DO NOTHING` makes a repeat confirm (or
   * a repeat correction) of the same version GRACEFUL — the duplicate inserts nothing and returns `undefined`
   * (idempotent), never an uncaught duplicate-key throw. Returns the inserted row, or `undefined` on a conflict.
   */
  insertConfirmationEvent(input: NewUnderstandingConfirmationEventInput): Promise<UnderstandingConfirmationEventRow | undefined> {
    return this.#db
      .insertInto('understanding_confirmation_events')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        document_id: input.documentId,
        version: input.version,
        kind: input.kind,
        actor_user_id: input.actorUserId,
        correction_ref: input.correctionRef,
        dependents_flagged: input.dependentsFlagged,
      })
      .onConflict((oc) => oc.columns(['document_id', 'kind']).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * The confirmation-lifecycle events of a document version (RLS-confined), chronological (oldest → newest). Ordered
   * by `created_at` with `id` as a deterministic tiebreak — NOT by the random-UUID `id` alone. (The `isVersionConfirmed`
   * gate predicate is order-independent, but a chronological list keeps any future "last event wins" consumer correct.)
   */
  listConfirmationEvents(documentId: string): Promise<UnderstandingConfirmationEventRow[]> {
    return this.#db.selectFrom('understanding_confirmation_events').selectAll().where('document_id', '=', documentId).orderBy('created_at', 'asc').orderBy('id', 'asc').execute();
  }
}
