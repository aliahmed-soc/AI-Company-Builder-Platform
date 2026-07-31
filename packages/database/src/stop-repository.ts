// @acbp/database — emergency-stop state and the held-work queue (ACBP-P6-007; CDR-072; migration 0050).
//
// THE READ THE DISPATCHER MAKES BEFORE EVERY TOOL CALL (invariant 14) is `listActive`. It is deliberately the
// simplest query in this file: RLS already restricts rows to `account = current AND (company IS NULL OR company =
// current)`, which is EXACTLY the covering set for a call in this scope — so the tenancy is enforced by the
// database and the covering relation is decided by the pure contract. Neither is re-implemented here, and there is
// no third place for them to disagree.
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from './schema.js';

export type StopExecutor = Kysely<DatabaseSchema>;

export interface EmergencyStopRow {
  readonly id: string;
  readonly account_id: string;
  readonly company_id: string | null;
  readonly scope: string;
  readonly target_id: string | null;
  readonly status: string;
  readonly reason: string | null;
  readonly activated_by_user_id: string;
  readonly activated_at: Date;
  readonly cleared_by_user_id: string | null;
  readonly cleared_at: Date | null;
}

export interface NewEmergencyStopInput {
  readonly accountId: string;
  /** NULL only for `account_wide` — the CHECK in migration 0050 is what keeps that true. */
  readonly companyId: string | null;
  readonly scope: string;
  readonly targetId: string | null;
  readonly reason: string | null;
  readonly activatedByUserId: string;
}

export interface NewHeldWorkInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly stopId: string;
  readonly taskId: string;
}

export class StopRepository {
  readonly #db: StopExecutor;

  constructor(db: StopExecutor) {
    this.#db = db;
  }

  /**
   * Every ACTIVE stop visible in this scope — the covering candidate set for any call here.
   *
   * NO SCOPE OR TARGET FILTERING. Filtering here would duplicate `evaluateStops`, and a duplicated covering rule is
   * one that can drift; the version that drifts silently is the one that misses a scope. This returns candidates,
   * the contract decides.
   */
  listActive(): Promise<EmergencyStopRow[]> {
    return this.#db
      .selectFrom('emergency_stops')
      .selectAll()
      .where('status', '=', 'active')
      .orderBy('activated_at')
      .orderBy('id')
      .execute();
  }

  /**
   * Activate a stop.
   *
   * `undefined` means the partial unique index fired: an identical active stop already exists. Targeted at THAT
   * constraint rather than a blanket 23505, so a conflict this method did not anticipate is not reported to the
   * caller as an ordinary duplicate.
   */
  insert(input: NewEmergencyStopInput): Promise<EmergencyStopRow | undefined> {
    return this.#db
      .insertInto('emergency_stops')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        scope: input.scope,
        target_id: input.targetId,
        reason: input.reason,
        activated_by_user_id: input.activatedByUserId,
      })
      // INFERENCE, not `ON CONSTRAINT`: the target is a PARTIAL unique INDEX, and PostgreSQL's
      // `ON CONFLICT ON CONSTRAINT` accepts only real table constraints (42704 at runtime otherwise). The predicate
      // below must stay identical to the index's own WHERE clause in migration 0050, and
      // `tools/check-conflict-targets.mjs` fails the build if they drift.
      .onConflict((oc) => oc.columns(['account_id', 'company_id', 'scope', 'target_id']).where('status', '=', 'active').doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Clear a stop. GUARDED ON `status = 'active'`, so a concurrent clearer gets `undefined` rather than silently
   * re-stamping a stop someone else already lifted — and the caller learns the difference.
   */
  clear(stopId: string, userId: string, at: Date): Promise<EmergencyStopRow | undefined> {
    return this.#db
      .updateTable('emergency_stops')
      .set({ status: 'cleared', cleared_at: at, cleared_by_user_id: userId })
      .where('id', '=', stopId)
      .where('status', '=', 'active')
      .returningAll()
      .executeTakeFirst();
  }

  findById(stopId: string): Promise<EmergencyStopRow | undefined> {
    return this.#db.selectFrom('emergency_stops').selectAll().where('id', '=', stopId).executeTakeFirst();
  }

  /** Hold a task under a stop. `undefined` when it is already held under that stop — holding twice is not a hold. */
  hold(input: NewHeldWorkInput): Promise<{ id: string } | undefined> {
    return this.#db
      .insertInto('held_work')
      .values({ account_id: input.accountId, company_id: input.companyId, stop_id: input.stopId, task_id: input.taskId })
      .onConflict((oc) => oc.constraint('held_work_stop_task_uq').doNothing())
      .returning('id')
      .executeTakeFirst();
  }

  listHeld(stopId: string): Promise<{ id: string; task_id: string; status: string }[]> {
    return this.#db
      .selectFrom('held_work')
      .select(['id', 'task_id', 'status'])
      .where('stop_id', '=', stopId)
      .where('status', '=', 'held')
      .orderBy('held_at')
      .orderBy('id')
      .execute();
  }

  /**
   * Record a review decision on one held item.
   *
   * Guarded on `status = 'held'`, so a second review of the same item returns `undefined` instead of overwriting the
   * first — ADMIN-002's review is a decision, and a decision that can be silently replaced is not one.
   */
  review(heldId: string, decision: 'confirmed' | 'discarded', userId: string, at: Date): Promise<{ id: string } | undefined> {
    return this.#db
      .updateTable('held_work')
      .set({ status: decision, reviewed_at: at, reviewed_by_user_id: userId })
      .where('id', '=', heldId)
      .where('status', '=', 'held')
      .returning('id')
      .executeTakeFirst();
  }
}
