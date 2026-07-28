// @acbp/database — task-run repository (ACBP-P5-002; CDR-053; TASK-007).
//
// A run is ONE EXECUTION ATTEMPT of a task. Every mutation here is GUARDED on the state the caller believed the run
// was in, because a coordinator, a worker and an owner can all act on the same run at once: the guard is what makes
// "someone else already decided" a detectable outcome rather than a silent overwrite.
//
// Kysely parameterized queries only. The app role holds SELECT + INSERT + a column-scoped UPDATE of the lifecycle
// columns; nothing here writes tenancy, task linkage or attempt number after insert, and the grant would refuse it.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DatabaseSchema, TaskRunRow } from './schema.js';

export type TaskRunExecutor = Kysely<DatabaseSchema>;

export interface NewTaskRunInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly taskId: string;
  readonly attempt: number;
}

export interface TransitionTaskRunInput {
  readonly runId: string;
  /** The state the caller believed it was in. A mismatch means someone else moved it first. */
  readonly expectedState: string;
  readonly nextState: string;
  readonly failureCategory?: string | null;
  /** Set on the transition INTO `running`. */
  readonly startedAt?: Date | null;
  /** Set on any terminal transition. */
  readonly endedAt?: Date | null;
}

export class TaskRunRepository {
  readonly #db: TaskRunExecutor;
  constructor(db: TaskRunExecutor) {
    this.#db = db;
  }

  /**
   * Claim an attempt. `ON CONFLICT (task_id, attempt) DO NOTHING` makes the claim atomic: two coordinators racing to
   * start attempt 2 do not both proceed, and the loser gets `undefined` rather than a duplicate run.
   */
  claimAttempt(input: NewTaskRunInput): Promise<TaskRunRow | undefined> {
    return this.#db
      .insertInto('task_runs')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        task_id: input.taskId,
        attempt: input.attempt,
        state: 'queued',
      })
      .onConflict((oc) => oc.columns(['task_id', 'attempt']).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /** Guarded lifecycle transition. `undefined` means the run was not in `expectedState` — never treat as success. */
  transition(input: TransitionTaskRunInput): Promise<TaskRunRow | undefined> {
    let q = this.#db
      .updateTable('task_runs')
      .set({
        state: input.nextState,
        failure_category: input.failureCategory ?? null,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', input.runId)
      .where('state', '=', input.expectedState);
    if (input.startedAt !== undefined) q = q.set({ started_at: input.startedAt });
    if (input.endedAt !== undefined) q = q.set({ ended_at: input.endedAt });
    return q.returningAll().executeTakeFirst();
  }

  /**
   * Advance liveness. Guarded on `running`, so a heartbeat cannot revive a run that was cancelled or reclaimed while
   * the worker was busy — which is precisely the case the heartbeat exists to detect.
   */
  heartbeat(runId: string): Promise<TaskRunRow | undefined> {
    return this.#db
      .updateTable('task_runs')
      .set({ last_heartbeat_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
      .where('id', '=', runId)
      .where('state', '=', 'running')
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Record a durable safe-stop request. Guarded on `running`; idempotent by design — asking twice keeps the FIRST
   * request time, so "when was the stop asked for?" has one answer.
   */
  requestStop(runId: string): Promise<TaskRunRow | undefined> {
    return this.#db
      .updateTable('task_runs')
      .set({ stop_requested_at: sql<Date>`coalesce(stop_requested_at, now())`, updated_at: sql<Date>`now()` })
      .where('id', '=', runId)
      .where('state', '=', 'running')
      .returningAll()
      .executeTakeFirst();
  }

  findById(runId: string): Promise<TaskRunRow | undefined> {
    return this.#db.selectFrom('task_runs').selectAll().where('id', '=', runId).executeTakeFirst();
  }

  /** A task's attempts, newest first. RLS confines this to the caller's company. */
  listForTask(taskId: string): Promise<TaskRunRow[]> {
    return this.#db.selectFrom('task_runs').selectAll().where('task_id', '=', taskId).orderBy('attempt', 'desc').execute();
  }

  /** Every run currently `running` in this company — the coordinator's liveness sweep. */
  listRunning(limit: number): Promise<TaskRunRow[]> {
    return this.#db.selectFrom('task_runs').selectAll().where('state', '=', 'running').orderBy('updated_at', 'asc').limit(limit).execute();
  }
}
