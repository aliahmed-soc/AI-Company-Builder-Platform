// @acbp/database — planning repository (ACBP-P4-001; CDR-039 §3; ROAD-001/002).
//
// Operates on the versioned `roadmaps` + immutable `goals`/`milestones`/`task_review_flags` rows. Takes a plain
// executor and relies on the caller to run it under the correct COMPANY scope (the dual-keyed policies deny anything
// else); the use case writes a version + its goals + its milestones + the audit event in ONE transaction. Kysely
// parameterized queries only; no raw SQL interpolation. Every table is append-only (SELECT + INSERT) — there is no
// update/delete path, so a new roadmap version is always a new row.
import type { Kysely } from 'kysely';
import { TERMINAL_TASK_STATES } from '@acbp/contracts';
import type { DatabaseSchema, RoadmapRow, GoalRow, MilestoneRow, TaskReviewFlagRow, TaskRow, PlanningRunRow, PlanningRunInputRow } from './schema.js';

export type PlanningExecutor = Kysely<DatabaseSchema>;

/** The fields a caller supplies to record a roadmap version (identity/created_at are server-set). */
export interface NewRoadmapInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly version: number;
  readonly decisionId: string;
  readonly status: string;
  readonly origin: string;
  readonly supersedesRoadmapId: string | null;
  readonly editReason: string | null;
  readonly modelFlaggedPartial: boolean;
  readonly createdByUserId: string;
}
export interface NewGoalInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly roadmapId: string;
  readonly ordinal: number;
  readonly title: string;
  readonly description: string | null;
}
export interface NewMilestoneInput extends NewGoalInput {
  readonly goalId: string | null;
}
export interface NewTaskReviewFlagInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly taskId: string;
  readonly roadmapId: string;
  readonly reason: string | null;
}

/**
 * The fields a caller supplies to record a planning run (ACBP-P4-006; identity/created_at are server-set).
 *
 * NOT named `NewPlanningRunInput`: `schema.ts` already exports that as `Insertable<PlanningRunInputsTable>` — a row of
 * the *inputs* table — so the two would collide the moment these types are re-exported from the package index, and
 * until then would silently type-check against the wrong shape.
 */
export interface NewPlanningRunFields {
  readonly accountId: string;
  readonly companyId: string;
  readonly mode: string;
  readonly outcome: string;
  readonly failureReason: string | null;
  readonly roadmapId: string;
  readonly roadmapVersion: number;
  readonly decisionId: string;
  readonly phaseScope: string | null;
  readonly taskCount: number;
  readonly tasksMissingRationale: number;
  readonly milestonesInScope: number;
  readonly milestonesOmitted: number;
  readonly memoryItemsConsidered: number;
  readonly memoryItemsOmitted: number;
  readonly createdByUserId: string;
}

/** One resolvable link from a run to something it considered. */
export interface NewPlanningRunInputLink {
  readonly accountId: string;
  readonly companyId: string;
  readonly runId: string;
  readonly kind: string;
  readonly refId: string;
}

/**
 * Task states that are TERMINAL — a task in one of these is not "open" for ROAD-002 flagging (CDR-039 §7-G7).
 * DERIVED from the contract's transition table, never hand-copied: a restated list would silently classify a task in a
 * newly-added terminal state as "open" and flag it for review forever.
 */
export const CLOSED_TASK_STATES: readonly string[] = TERMINAL_TASK_STATES;

export class PlanningRepository {
  readonly #db: PlanningExecutor;
  constructor(db: PlanningExecutor) {
    this.#db = db;
  }

  /** Insert one roadmap version (append-only). RLS confines the write to the caller's company scope. */
  insertRoadmap(input: NewRoadmapInput): Promise<RoadmapRow> {
    return this.#db
      .insertInto('roadmaps')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        version: input.version,
        decision_id: input.decisionId,
        status: input.status,
        origin: input.origin,
        supersedes_roadmap_id: input.supersedesRoadmapId,
        edit_reason: input.editReason,
        model_flagged_partial: input.modelFlaggedPartial,
        created_by_user_id: input.createdByUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  insertGoal(input: NewGoalInput): Promise<GoalRow> {
    return this.#db
      .insertInto('goals')
      .values({ account_id: input.accountId, company_id: input.companyId, roadmap_id: input.roadmapId, ordinal: input.ordinal, title: input.title, description: input.description })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  insertMilestone(input: NewMilestoneInput): Promise<MilestoneRow> {
    return this.#db
      .insertInto('milestones')
      .values({ account_id: input.accountId, company_id: input.companyId, roadmap_id: input.roadmapId, goal_id: input.goalId, ordinal: input.ordinal, title: input.title, description: input.description })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Flag one task for review against a roadmap version. Genuinely idempotent: a repeat for the same
   * (task, version) is a no-op rather than a unique-violation, so a retry can never fail the surrounding transaction.
   * Returns undefined when the flag already existed.
   */
  insertTaskReviewFlag(input: NewTaskReviewFlagInput): Promise<TaskReviewFlagRow | undefined> {
    return this.#db
      .insertInto('task_review_flags')
      .values({ account_id: input.accountId, company_id: input.companyId, task_id: input.taskId, roadmap_id: input.roadmapId, reason: input.reason })
      .onConflict((oc) => oc.columns(['task_id', 'roadmap_id']).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /** The company's CURRENT (highest-version) roadmap (RLS-confined), or undefined when none exists yet. */
  latestRoadmap(companyId: string): Promise<RoadmapRow | undefined> {
    return this.#db.selectFrom('roadmaps').selectAll().where('company_id', '=', companyId).orderBy('version', 'desc').limit(1).executeTakeFirst();
  }

  /** A single roadmap version by id (RLS-confined; undefined when absent/invisible). */
  findRoadmap(id: string): Promise<RoadmapRow | undefined> {
    return this.#db.selectFrom('roadmaps').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** The goals of a roadmap version (RLS-confined), in ordinal order. */
  listGoals(roadmapId: string): Promise<GoalRow[]> {
    return this.#db.selectFrom('goals').selectAll().where('roadmap_id', '=', roadmapId).orderBy('ordinal', 'asc').execute();
  }

  /** The milestones of a roadmap version (RLS-confined), in ordinal order (ROAD-001 target sequencing). */
  listMilestones(roadmapId: string): Promise<MilestoneRow[]> {
    return this.#db.selectFrom('milestones').selectAll().where('roadmap_id', '=', roadmapId).orderBy('ordinal', 'asc').execute();
  }

  /**
   * The OPEN tasks affected by creating a new roadmap version (ROAD-002 "affected open tasks are flagged for review";
   * CDR-039 §7-G7): every non-terminal task of this company whose milestone belongs to a roadmap version that the new
   * version supersedes.
   *
   * Scoped by COMPANY, not by the single version being superseded: tasks are never re-pointed at the new version's
   * milestones, so after the first revision they still reference the ORIGINAL version. Keying on "the version being
   * superseded" would therefore flag correctly once and then silently stop — a task two revisions stale would never be
   * flagged again. At call time (before the new version is inserted) every existing milestone belongs to a version the
   * new one supersedes, so joining through `milestones` is exactly the affected set. RLS confines both sides.
   */
  listAffectedOpenTasks(companyId: string): Promise<TaskRow[]> {
    return this.#db
      .selectFrom('tasks')
      .selectAll('tasks')
      .innerJoin('milestones', 'milestones.id', 'tasks.milestone_id')
      .where('tasks.company_id', '=', companyId)
      .where('tasks.state', 'not in', [...CLOSED_TASK_STATES])
      .orderBy('tasks.id', 'asc')
      .execute();
  }

  /** The review flags raised against a task (RLS-confined), newest first. */
  listTaskReviewFlags(taskId: string): Promise<TaskReviewFlagRow[]> {
    return this.#db.selectFrom('task_review_flags').selectAll().where('task_id', '=', taskId).orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
  }

  // ── planning transparency (ACBP-P4-006; PLAN-004) ───────────────────────────────────────────────────────

  /** Insert one planning run (append-only). Written in the same transaction as its inputs and its audit event. */
  insertPlanningRun(input: NewPlanningRunFields): Promise<PlanningRunRow> {
    return this.#db
      .insertInto('planning_runs')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        mode: input.mode,
        outcome: input.outcome,
        failure_reason: input.failureReason,
        roadmap_id: input.roadmapId,
        roadmap_version: input.roadmapVersion,
        decision_id: input.decisionId,
        phase_scope: input.phaseScope,
        task_count: input.taskCount,
        tasks_missing_rationale: input.tasksMissingRationale,
        milestones_in_scope: input.milestonesInScope,
        milestones_omitted: input.milestonesOmitted,
        memory_items_considered: input.memoryItemsConsidered,
        memory_items_omitted: input.memoryItemsOmitted,
        created_by_user_id: input.createdByUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Link the things a run considered, in ONE statement. `ON CONFLICT DO NOTHING` on the (run, kind, ref) triple makes a
   * repeated input a no-op rather than a unique-violation that would abort the surrounding transaction — the same
   * input recorded twice for one run is the same fact, not two.
   *
   * A no-op on an empty list: a run that considered no memory items still records its roadmap/decision/milestone links,
   * and an INSERT with no rows would throw.
   */
  async insertPlanningRunInputs(inputs: readonly NewPlanningRunInputLink[]): Promise<number> {
    if (inputs.length === 0) return 0;
    const rows = await this.#db
      .insertInto('planning_run_inputs')
      .values(inputs.map((i) => ({ account_id: i.accountId, company_id: i.companyId, run_id: i.runId, kind: i.kind, ref_id: i.refId })))
      .onConflict((oc) => oc.columns(['run_id', 'kind', 'ref_id']).doNothing())
      .returningAll()
      .execute();
    return rows.length;
  }

  /** A company's planning runs (RLS-confined), newest first, bounded. */
  listPlanningRuns(companyId: string, limit: number): Promise<PlanningRunRow[]> {
    return this.#db.selectFrom('planning_runs').selectAll().where('company_id', '=', companyId).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
  }

  /** The inputs a run considered (RLS-confined), grouped stably by kind then id. */
  listPlanningRunInputs(runId: string): Promise<PlanningRunInputRow[]> {
    return this.#db.selectFrom('planning_run_inputs').selectAll().where('run_id', '=', runId).orderBy('kind', 'asc').orderBy('id', 'asc').execute();
  }
}
