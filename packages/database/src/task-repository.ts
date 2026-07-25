// @acbp/database — task repository (ACBP-P4-002; CDR-033 §3/§4).
//
// Operates on the `tasks` (mutable-state) + `task_dependencies` (immutable edge) rows. Takes a plain executor and
// relies on the caller to run it under the correct COMPANY scope (the dual-keyed policies deny anything else); the use
// case writes the task/state change + its audit event in ONE transaction. Kysely parameterized queries only; no raw
// SQL interpolation. The only mutation on `tasks` is a column-scoped `state`/`updated_at` update (identity/provenance
// columns are immutable to the app role); `task_dependencies` is append-only (no update/delete).
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { DatabaseSchema, TaskRow, TaskDependencyRow } from './schema.js';

export type TaskExecutor = Kysely<DatabaseSchema>;

/** The fields a caller supplies to create a task (identity/state are server-set; a task is minted in `draft`). */
export interface NewTaskInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly title: string;
  readonly description: string | null;
  readonly milestoneId: string | null;
  readonly createdByUserId: string;
}

export interface NewTaskDependencyInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly taskId: string;
  readonly dependsOnTaskId: string;
}

export interface ListTasksOptions {
  readonly limit: number;
}

export class TaskRepository {
  readonly #db: TaskExecutor;
  constructor(db: TaskExecutor) {
    this.#db = db;
  }

  /** Insert a task (server-minted in `draft`). RLS confines the write to the caller's company scope. */
  insert(input: NewTaskInput): Promise<TaskRow> {
    return this.#db
      .insertInto('tasks')
      .values({ account_id: input.accountId, company_id: input.companyId, state: 'draft', title: input.title, description: input.description, milestone_id: input.milestoneId, created_by_user_id: input.createdByUserId })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** A single task by id (RLS-confined; undefined when absent/invisible). */
  findById(id: string): Promise<TaskRow | undefined> {
    return this.#db.selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /**
   * Advance a task's state, GUARDED by the current state (optimistic, race-safe): the `where state = fromState` makes
   * the update a no-op (returns 0) if the row already left `fromState`, so exactly one transition wins. Returns the
   * number of rows updated (0 = the guard did not match). Only `state` + `updated_at` are writable (column grant).
   */
  async updateState(id: string, fromState: string, toState: string): Promise<number> {
    const r = await this.#db.updateTable('tasks').set({ state: toState, updated_at: sql`now()` }).where('id', '=', id).where('state', '=', fromState).executeTakeFirst();
    return Number(r.numUpdatedRows);
  }

  /** The company's tasks (RLS-confined), newest first, bounded. */
  list(options: ListTasksOptions): Promise<TaskRow[]> {
    return this.#db.selectFrom('tasks').selectAll().orderBy('created_at', 'desc').orderBy('id', 'desc').limit(options.limit).execute();
  }

  /**
   * Insert an immutable Task↔Task dependency edge, RACE-SAFE: `ON CONFLICT (task_id, depends_on_task_id) DO NOTHING`
   * makes a concurrent duplicate a graceful no-op (returns `undefined`) instead of a UNIQUE-violation throw, so the
   * caller can map it to a clean `duplicate` result without a separate check-then-insert TOCTOU window.
   */
  insertDependency(input: NewTaskDependencyInput): Promise<TaskDependencyRow | undefined> {
    return this.#db
      .insertInto('task_dependencies')
      .values({ account_id: input.accountId, company_id: input.companyId, task_id: input.taskId, depends_on_task_id: input.dependsOnTaskId })
      .onConflict((oc) => oc.columns(['task_id', 'depends_on_task_id']).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /** The dependency edges of a task (RLS-confined), in insertion order. */
  listDependencies(taskId: string): Promise<TaskDependencyRow[]> {
    return this.#db.selectFrom('task_dependencies').selectAll().where('task_id', '=', taskId).orderBy('id', 'asc').execute();
  }
}
