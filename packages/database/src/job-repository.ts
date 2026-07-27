// @acbp/database — durable job store repository (ACBP-P5-001a; CDR-049 §4; ADR-008).
//
// Operates on the `jobs` table, which WE own (CDR-049 §2-G1) precisely so tenancy can be structural. Takes a plain
// executor and relies on the caller to run it under the correct COMPANY scope; the dual-keyed RLS `WITH CHECK` denies
// anything else, which is the second of the three refusal layers (§3-G3). Kysely parameterized queries only.
//
// The app role holds SELECT + INSERT + a column-scoped `UPDATE(state, updated_at, attempts)`. Nothing here writes
// `account_id`/`company_id`/`kind`/`payload` after insert, and nothing could: the grant does not permit it.
import type { Kysely } from 'kysely';
import type { DatabaseSchema, JobRow } from './schema.js';

export type JobExecutor = Kysely<DatabaseSchema>;

/** The fields a caller supplies to enqueue a job. Identity, state and timestamps are server-set. */
export interface NewJobInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly kind: string;
  /** References, NEVER secrets (ADR-008 §11). */
  readonly payload: Record<string, unknown>;
  /** Absent/null when the job is not deduplicable; unique per company when present (TASK-009/NFR-006). */
  readonly idempotencyKey?: string | null;
  readonly createdByUserId: string;
}

export class JobRepository {
  readonly #db: JobExecutor;
  constructor(db: JobExecutor) {
    this.#db = db;
  }

  /**
   * Enqueue a job, or return the row that already holds this idempotency key.
   *
   * `ON CONFLICT DO NOTHING` is scoped to the EXACT partial unique index `(company_id, idempotency_key)` — never a
   * blanket 23505 catch, which would silently swallow an unrelated constraint violation and report a duplicate that
   * was really a different bug. When the conflict fires, `executeTakeFirst` returns undefined and the caller reads
   * the existing row back; that read is confined by RLS to the caller's own company, so the "already enqueued" answer
   * can never be another tenant's job.
   */
  insert(input: NewJobInput): Promise<JobRow | undefined> {
    return this.#db
      .insertInto('jobs')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        kind: input.kind,
        state: 'queued',
        payload: input.payload,
        idempotency_key: input.idempotencyKey ?? null,
        created_by_user_id: input.createdByUserId,
      })
      .onConflict((oc) => oc.columns(['company_id', 'idempotency_key']).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /** The existing job for an idempotency key, if any. RLS confines this to the caller's company. */
  findByIdempotencyKey(idempotencyKey: string): Promise<JobRow | undefined> {
    return this.#db.selectFrom('jobs').selectAll().where('idempotency_key', '=', idempotencyKey).executeTakeFirst();
  }

  findById(id: string): Promise<JobRow | undefined> {
    return this.#db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirst();
  }
}
