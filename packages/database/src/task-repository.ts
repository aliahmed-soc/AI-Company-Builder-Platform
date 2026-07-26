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
  /** ACBP-P4-003: the planned type, or null when not stated (never guessed). Manual creation supplies none. */
  readonly taskType?: string | null;
  /** ACBP-P4-003: the planning RANK (0 = first), or null for a manually created task. */
  readonly priority?: number | null;
  /** ACBP-P4-006 (PLAN-004): why this task was chosen, or null when the model gave none ("not recorded"). */
  readonly rationale?: string | null;
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
      .values({ account_id: input.accountId, company_id: input.companyId, state: 'draft', title: input.title, description: input.description, milestone_id: input.milestoneId, task_type: input.taskType ?? null, priority: input.priority ?? null, rationale: input.rationale ?? null, created_by_user_id: input.createdByUserId })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * The highest planning RANK already used by this company, or -1 when nothing has been ranked (ACBP-P4-003).
   * Read as a MAX rather than by scanning a page: a page ordered by recency could miss older ranked rows behind newer
   * unranked (manually created) ones and silently restart the rank at 0.
   */
  async maxPriority(companyId: string): Promise<number> {
    const row = await this.#db.selectFrom('tasks').select((eb) => eb.fn.max('priority').as('max')).where('company_id', '=', companyId).executeTakeFirst();
    const max = row?.max;
    // Only "no ranked rows yet" may fall back to -1. Anything else that is not a finite number is a DRIVER surprise
    // (node-pg hands int8 back as a string, so a widened column or a type-parser change would land here) — coercing it
    // to -1 would silently restart the rank at 0 and reintroduce the collision this method exists to prevent.
    if (max === null || max === undefined) return -1;
    const n = Number(max);
    if (!Number.isFinite(n)) throw new TypeError('tasks.priority MAX did not read back as a number');
    return n;
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

  /**
   * One page of BOARD tasks — everything except `draft` (ACBP-P4-004).
   *
   * Drafts are excluded IN THE QUERY, not after it. `list` orders newest-first and drafts are rows like any other, so
   * a planning run that mints a page-worth of drafts would otherwise consume the entire budget and leave the board
   * rendering empty while real `planned`/`running` work existed — the "a task in no bucket is invisible" failure
   * arriving through the pagination door. The limit must bound BOARD rows to mean anything.
   */
  listBoardPage(options: ListTasksOptions): Promise<TaskRow[]> {
    return this.#db.selectFrom('tasks').selectAll().where('state', '!=', 'draft').orderBy('created_at', 'desc').orderBy('id', 'desc').limit(options.limit).execute();
  }

  /** How many DRAFT tasks the company holds (RLS-confined). Counted, not paged: the board reports them off-board. */
  async countDrafts(companyId: string): Promise<number> {
    const row = await this.#db
      .selectFrom('tasks')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('company_id', '=', companyId)
      .where('state', '=', 'draft')
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  /**
   * Dependency edges touching ANY of `taskIds`, in either direction (RLS-confined; ACBP-P4-004).
   *
   * Scoped to the rendered page rather than the whole company: one query still (a per-task fetch could render a task
   * against a different snapshot than its prerequisites, showing "blocked" and "ready" states that never coexisted),
   * but BOUNDED — `task_dependencies` is append-only with no cap, so a company that scripts edge creation could
   * otherwise make every board read materialise an unbounded row set from a single cheap request.
   *
   * The `limit` bounds the RESULT, not just the IN list. Scoping to a bounded set of page ids caps the predicate but
   * not the rows returned: one task may carry unlimited edges, and the ids harvested from those rows then feed an
   * `in (...)` lookup that would blow past the bind-parameter ceiling long before memory became the issue.
   */
  listDependenciesForTasks(taskIds: readonly string[], limit: number): Promise<TaskDependencyRow[]> {
    if (taskIds.length === 0) return Promise.resolve([]);
    const ids = [...taskIds];
    return this.#db
      .selectFrom('task_dependencies')
      .selectAll()
      .where((eb) => eb.or([eb('task_id', 'in', ids), eb('depends_on_task_id', 'in', ids)]))
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
  }

  /**
   * The states of specific tasks (RLS-confined), for resolving prerequisites that fall OUTSIDE the rendered page.
   *
   * Without this, a truncated board reports almost every dependent as blocked: `list` is newest-first, so
   * prerequisites are by construction older than their dependents and are the FIRST rows dropped. Failing closed on a
   * prerequisite we simply did not fetch is safe but wrong often enough to make the indicator useless.
   */
  findStatesByIds(taskIds: readonly string[]): Promise<{ id: string; state: string }[]> {
    if (taskIds.length === 0) return Promise.resolve([]);
    return this.#db
      .selectFrom('tasks')
      .select(['id', 'state'])
      .where('id', 'in', [...taskIds])
      .execute();
  }
}
