// @acbp/database — durable job store repository (ACBP-P5-001a; CDR-049 §4; ADR-008).
//
// Operates on the `jobs` table, which WE own (CDR-049 §2-G1) precisely so tenancy can be structural. Takes a plain
// executor and relies on the caller to run it under the correct COMPANY scope; the dual-keyed RLS `WITH CHECK` denies
// anything else, which is the second of the three refusal layers (§3-G3). Kysely parameterized queries only.
//
// The app role holds SELECT + INSERT + a column-scoped `UPDATE(state, updated_at, attempts)`. Nothing here writes
// `account_id`/`company_id`/`kind`/`payload` after insert, and nothing could: the grant does not permit it.
import type { Kysely } from 'kysely';
import type { DatabaseSchema, JobRow, JobCheckpointRow } from './schema.js';

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

/** What a caller supplies to record a completed step (ACBP-P5-001b). Identity and time are server-set. */
export interface NewJobCheckpointInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly jobId: string;
  readonly stepName: string;
  /** What the step produced for a later step. References, NEVER secrets. Absent/null for most steps. */
  readonly output?: Record<string, unknown> | null;
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
      // The arbiter WHERE is REQUIRED, not decoration: `jobs_company_idempotency_uq` is a PARTIAL index, and
      // PostgreSQL will not infer a partial index from a bare column list — it raises 42P10 ("no unique or exclusion
      // constraint matching the ON CONFLICT specification"). The predicate here must stay identical to the index's.
      .onConflict((oc) => oc.columns(['company_id', 'idempotency_key']).where('idempotency_key', 'is not', null).doNothing())
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

  // ── checkpoints (ACBP-P5-001b; CDR-050) ──────────────────────────────────────────────────────────────────

  /**
   * Record that a step COMPLETED. Called in the SAME transaction as the step's effect (CDR-050 §3-G5), so a crash can
   * never leave the effect landed and the record missing — which is the case that would cause a re-run to execute it
   * twice.
   *
   * `ON CONFLICT (job_id, step_name) DO NOTHING` makes a duplicate completion the SAME FACT rather than a second row,
   * so the race between two workers that both believe they own the step resolves at the database instead of in a
   * check-then-insert that would itself race. Scoped to the exact constraint, never a blanket 23505.
   *
   * Returns the row when this call created it, and `undefined` when it was already there — which is the caller's
   * signal that someone else completed the step first.
   */
  insertCheckpoint(input: NewJobCheckpointInput): Promise<JobCheckpointRow | undefined> {
    return this.#db
      .insertInto('job_checkpoints')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        job_id: input.jobId,
        step_name: input.stepName,
        output: input.output ?? null,
      })
      .onConflict((oc) => oc.columns(['job_id', 'step_name']).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Every checkpoint for a job, oldest first. RLS confines this to the caller's company.
   *
   * `step_name` is the TIEBREAK, and it is not decoration: `created_at` defaults to `now()`, which in PostgreSQL is
   * TRANSACTION start time — so two steps checkpointed in one transaction carry the identical timestamp and their
   * relative order would otherwise be whatever the planner returned. `completedSteps` is surfaced to callers, so an
   * arbitrary order there is both a flaky-test source and a confusing read.
   */
  listCheckpoints(jobId: string): Promise<JobCheckpointRow[]> {
    return this.#db.selectFrom('job_checkpoints').selectAll().where('job_id', '=', jobId).orderBy('created_at', 'asc').orderBy('step_name', 'asc').execute();
  }
}
