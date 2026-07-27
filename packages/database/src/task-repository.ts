// @acbp/database — task repository (ACBP-P4-002; CDR-033 §3/§4).
//
// Operates on the `tasks` (mutable-state) + `task_dependencies` (immutable edge) rows. Takes a plain executor and
// relies on the caller to run it under the correct COMPANY scope (the dual-keyed policies deny anything else); the use
// case writes the task/state change + its audit event in ONE transaction. Kysely parameterized queries only; no raw
// SQL interpolation. The only mutation on `tasks` is a column-scoped `state`/`updated_at` update (identity/provenance
// columns are immutable to the app role); `task_dependencies` is append-only (no update/delete).
import type { ExpressionBuilder, ExpressionWrapper, Kysely, SqlBool } from 'kysely';
import { sql } from 'kysely';
import type { DatabaseSchema, TaskRow, TaskDependencyRow, TaskDeletionRow } from './schema.js';

export type TaskExecutor = Kysely<DatabaseSchema>;

/**
 * "This task has not been deleted" (ACBP-P4-005). `tasks` carries no DELETE grant, so a deleted task's row survives
 * and every product read has to exclude it explicitly — a NOT EXISTS against the append-only `task_deletions` record.
 *
 * Shared rather than repeated per query: an exclusion that some reads apply and others forget is exactly how a task
 * the owner discarded reappears on one screen but not another. RLS still confines both sides to the caller's company.
 */
const NOT_DELETED = (eb: ExpressionBuilder<DatabaseSchema, 'tasks'>): ExpressionWrapper<DatabaseSchema, 'tasks', SqlBool> =>
  eb.not(eb.exists(eb.selectFrom('task_deletions').select('task_deletions.id').whereRef('task_deletions.task_id', '=', 'tasks.id')));

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
  /** ACBP-P4-005 (TASK-008): the task this one was repeated FROM, or null/absent when it is not a repeat. */
  readonly repeatedFromTaskId?: string | null;
  readonly createdByUserId: string;
}

export interface NewTaskDependencyInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly taskId: string;
  readonly dependsOnTaskId: string;
}

/** The fields recorded when an owner deletes a task (ACBP-P4-005; TASK-008). Append-only — nothing is erased. */
export interface NewTaskDeletionInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly taskId: string;
  /** The state the task held at the moment of deletion — the only place that fact survives once reads filter it out. */
  readonly stateAtDelete: string;
  /** The owner's optional note. Stored here, NEVER in the audit payload (which records only `has_reason`). */
  readonly reason: string | null;
  readonly deletedByUserId: string;
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
      .values({ account_id: input.accountId, company_id: input.companyId, state: 'draft', title: input.title, description: input.description, milestone_id: input.milestoneId, task_type: input.taskType ?? null, priority: input.priority ?? null, rationale: input.rationale ?? null, repeated_from_task_id: input.repeatedFromTaskId ?? null, created_by_user_id: input.createdByUserId })
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

  /** A single task by id (RLS-confined; undefined when absent/invisible). Includes deleted tasks — see `findLive`. */
  findById(id: string): Promise<TaskRow | undefined> {
    return this.#db.selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /**
   * A single NON-DELETED task (ACBP-P4-005). `tasks` has no DELETE grant, so a deleted task's row survives; every
   * product read must exclude it explicitly or the owner would keep seeing work they discarded.
   *
   * `findById` deliberately still returns deleted rows, but NO product read may use it: it exists for callers that
   * genuinely want the raw row regardless of deletion state (diagnostics, and the deletion record's own back-reference).
   * Every use case that answers a user question reads through `findLive`.
   */
  findLive(id: string): Promise<TaskRow | undefined> {
    return this.#db.selectFrom('tasks').selectAll().where('id', '=', id).where(NOT_DELETED).executeTakeFirst();
  }

  /**
   * Insert the append-only deletion record, GUARDED by the task's current state (optimistic, race-safe).
   *
   * The guard is the `where state = stateAtDelete` inside the INSERT ... SELECT, and it is load-bearing rather than
   * defensive. Without it the use case is a check-then-insert: it reads `queued` (deletable), and if the task starts
   * running in that window the unguarded insert still succeeds — deleting a RUNNING task, which is precisely what
   * TASK-008's failure clause forbids. Doing the check and the write in ONE statement closes that window at the
   * database, the same idiom `updateState` uses for transitions.
   *
   * `ON CONFLICT (task_id) DO NOTHING` additionally makes a concurrent duplicate delete a graceful no-op rather than
   * a UNIQUE-violation throw. Returns `undefined` for BOTH misses — the state moved, or someone else deleted it
   * first — so the caller re-reads to tell them apart.
   */
  insertDeletion(input: NewTaskDeletionInput): Promise<TaskDeletionRow | undefined> {
    return this.#db
      .insertInto('task_deletions')
      .columns(['account_id', 'company_id', 'task_id', 'state_at_delete', 'reason', 'deleted_by_user_id'])
      .expression((eb) =>
        eb
          .selectFrom('tasks')
          .select([
            // Explicit casts: in an INSERT ... SELECT, PostgreSQL resolves the SELECT list's types on its own, so a
            // bare parameter would fail with "could not determine data type". Still fully parameterized.
            sql<string>`${input.accountId}::uuid`.as('account_id'),
            sql<string>`${input.companyId}::uuid`.as('company_id'),
            sql<string>`${input.taskId}::uuid`.as('task_id'),
            sql<string>`${input.stateAtDelete}::text`.as('state_at_delete'),
            sql<string | null>`${input.reason}::text`.as('reason'),
            sql<string>`${input.deletedByUserId}::uuid`.as('deleted_by_user_id'),
          ])
          .where('tasks.id', '=', input.taskId)
          .where('tasks.state', '=', input.stateAtDelete),
      )
      .onConflict((oc) => oc.column('task_id').doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /** The deletion record for a task, when it has one (RLS-confined). */
  findDeletion(taskId: string): Promise<TaskDeletionRow | undefined> {
    return this.#db.selectFrom('task_deletions').selectAll().where('task_id', '=', taskId).executeTakeFirst();
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

  /** The company's non-deleted tasks (RLS-confined), newest first, bounded (ACBP-P4-005 G9). */
  list(options: ListTasksOptions): Promise<TaskRow[]> {
    return this.#db.selectFrom('tasks').selectAll().where(NOT_DELETED).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(options.limit).execute();
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
    return this.#db
      .selectFrom('tasks')
      .selectAll()
      .where('state', '!=', 'draft')
      // Deleted tasks are gone from the board (ACBP-P4-005; CDR-043 §4-G9). Excluded in the QUERY so they never
      // consume page budget — the same reasoning that keeps drafts out.
      .where(NOT_DELETED)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(options.limit)
      .execute();
  }

  /**
   * How many DRAFT tasks the company holds (RLS-confined). Counted, not paged: the board reports them off-board.
   *
   * Deleted drafts are excluded (ACBP-P4-005 G9). Counting them would tell the owner that preview work exists which
   * they can no longer reach from anywhere — a number that cannot be acted on is worse than no number.
   */
  async countDrafts(companyId: string): Promise<number> {
    const row = await this.#db
      .selectFrom('tasks')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('company_id', '=', companyId)
      .where('state', '=', 'draft')
      .where(NOT_DELETED)
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
   *
   * DELETED prerequisites are deliberately NOT excluded here (ACBP-P4-005). This resolves a task's real state, and a
   * deleted prerequisite's last state is the honest answer: one deleted while `completed` genuinely did unblock its
   * dependent, and one deleted while `planned` genuinely blocks it forever. Filtering them out would collapse both
   * into "unresolvable → blocked", turning a satisfied dependency into a permanent false block.
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
