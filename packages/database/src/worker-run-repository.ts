// @acbp/database — worker runs (ACBP-P5-005; CDR-057; WORK-006; NFR-015).
//
// The stamp linking a task run to the worker executing it. Every mutation is GUARDED on `running`, because a worker
// run that has already reported an outcome must not be re-opened by a late step: the counters would keep moving on a
// run that is over, and the record would stop being the account of what happened.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DatabaseSchema, WorkerRunRow } from './schema.js';

export type WorkerRunExecutor = Kysely<DatabaseSchema>;

export interface NewWorkerRunInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly taskRunId: string;
  readonly workerId: string;
  readonly workerVersion: number;
  readonly maxSpendMicros: number;
  readonly maxDurationMs: number;
}

export interface FinishWorkerRunInput {
  readonly workerRunId: string;
  readonly outcome: string;
  readonly failureCategory?: string | null;
  readonly haltReason?: string | null;
}

export class WorkerRunRepository {
  readonly #db: WorkerRunExecutor;
  constructor(db: WorkerRunExecutor) {
    this.#db = db;
  }

  /**
   * Stamp a worker onto a task run. `undefined` means this attempt already has a worker — `UNIQUE(task_run_id)`
   * fired, which is the constraint expressing "one worker executes one attempt".
   */
  start(input: NewWorkerRunInput): Promise<WorkerRunRow | undefined> {
    return this.#db
      .insertInto('worker_runs')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        task_run_id: input.taskRunId,
        worker_id: input.workerId,
        worker_version: input.workerVersion,
        max_spend_micros: input.maxSpendMicros,
        max_duration_ms: input.maxDurationMs,
      })
      .onConflict((oc) => oc.column('task_run_id').doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Record what a step cost. GUARDED on `running`, and the increment is done IN SQL rather than read-modify-write:
   * two concurrent steps would otherwise both read the old total and the second would overwrite the first's spend,
   * losing money from the very counter the budget is enforced against.
   */
  recordStep(workerRunId: string, spentMicros: number): Promise<WorkerRunRow | undefined> {
    return this.#db
      .updateTable('worker_runs')
      .set({
        spend_micros: sql<number>`spend_micros + ${spentMicros}`,
        steps_completed: sql<number>`steps_completed + 1`,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', workerRunId)
      .where('outcome', '=', 'running')
      .returningAll()
      .executeTakeFirst();
  }

  /** Close the run. GUARDED on `running`: a run that already reported cannot report again. */
  finish(input: FinishWorkerRunInput): Promise<WorkerRunRow | undefined> {
    return this.#db
      .updateTable('worker_runs')
      .set({
        outcome: input.outcome,
        failure_category: input.failureCategory ?? null,
        halt_reason: input.haltReason ?? null,
        ended_at: sql<Date>`now()`,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', input.workerRunId)
      .where('outcome', '=', 'running')
      .returningAll()
      .executeTakeFirst();
  }

  findById(workerRunId: string): Promise<WorkerRunRow | undefined> {
    return this.#db.selectFrom('worker_runs').selectAll().where('id', '=', workerRunId).executeTakeFirst();
  }

  /**
   * The run, plus how long it has been running **measured by the DATABASE's clock**.
   *
   * Found in review pass 2: computing `Date.now() - started_at` mixes two clocks. `started_at` is a Postgres `now()`
   * and the caller's is Node's; a few seconds of skew either way makes the elapsed time wrong, and skew in the
   * negative direction makes it NEGATIVE — which the fail-closed bounds check would read as "unreadable" and halt a
   * perfectly healthy run. Subtracting two timestamps from ONE clock has neither problem.
   */
  findByIdForUpdate(workerRunId: string): Promise<(WorkerRunRow & { elapsed_ms: number }) | undefined> {
    return this.#db
      .selectFrom('worker_runs')
      .selectAll()
      .select(sql<number>`(extract(epoch from (now() - started_at)) * 1000)::bigint::int`.as('elapsed_ms'))
      .where('id', '=', workerRunId)
      // FOR UPDATE, because the admission decision that follows must not be made twice on one run. Two callers
      // reading the same spend would both find headroom and both execute, turning NFR-015's one-increment bound into
      // N — and the in-SQL increment below cannot help, since it prevents a lost update, not a double admission.
      .forUpdate()
      .executeTakeFirst();
  }

  findByTaskRun(taskRunId: string): Promise<WorkerRunRow | undefined> {
    return this.#db.selectFrom('worker_runs').selectAll().where('task_run_id', '=', taskRunId).executeTakeFirst();
  }

  /**
   * Every RUNNING run of one worker in this company — what WORK-006's safe-stop sweep needs, and the read that was
   * impossible before this table existed (`CDR-056 §6`). RLS confines it to the caller's company.
   */
  listRunningForWorker(workerId: string): Promise<WorkerRunRow[]> {
    return this.#db.selectFrom('worker_runs').selectAll().where('worker_id', '=', workerId).where('outcome', '=', 'running').execute();
  }
}
