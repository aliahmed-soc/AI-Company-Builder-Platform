// @acbp/database — planning repository (ACBP-P4-001; CDR-039 §3; ROAD-001/002).
//
// Operates on the versioned `roadmaps` + immutable `goals`/`milestones`/`task_review_flags` rows. Takes a plain
// executor and relies on the caller to run it under the correct COMPANY scope (the dual-keyed policies deny anything
// else); the use case writes a version + its goals + its milestones + the audit event in ONE transaction. Kysely
// parameterized queries only; no raw SQL interpolation. Every table is append-only (SELECT + INSERT) — there is no
// update/delete path, so a new roadmap version is always a new row.
import type { Kysely } from 'kysely';
import type { DatabaseSchema, RoadmapRow, GoalRow, MilestoneRow, TaskReviewFlagRow, TaskRow } from './schema.js';

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

/** Task states that are TERMINAL — a task in one of these is not "open" for ROAD-002 flagging (CDR-039 §7-G7). */
export const CLOSED_TASK_STATES = ['completed', 'failed', 'cancelled'] as const;

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

  insertTaskReviewFlag(input: NewTaskReviewFlagInput): Promise<TaskReviewFlagRow> {
    return this.#db
      .insertInto('task_review_flags')
      .values({ account_id: input.accountId, company_id: input.companyId, task_id: input.taskId, roadmap_id: input.roadmapId, reason: input.reason })
      .returningAll()
      .executeTakeFirstOrThrow();
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
   * The OPEN tasks affected by superseding `roadmapId` (ROAD-002 / CDR-039 §7-G7): tasks whose milestone belongs to
   * that roadmap version and whose state is not terminal. RLS-confined to the caller's company.
   */
  listAffectedOpenTasks(roadmapId: string): Promise<TaskRow[]> {
    return this.#db
      .selectFrom('tasks')
      .selectAll('tasks')
      .innerJoin('milestones', 'milestones.id', 'tasks.milestone_id')
      .where('milestones.roadmap_id', '=', roadmapId)
      .where('tasks.state', 'not in', [...CLOSED_TASK_STATES])
      .orderBy('tasks.id', 'asc')
      .execute();
  }

  /** The review flags raised against a task (RLS-confined), newest first. */
  listTaskReviewFlags(taskId: string): Promise<TaskReviewFlagRow[]> {
    return this.#db.selectFrom('task_review_flags').selectAll().where('task_id', '=', taskId).orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
  }
}
