// @acbp/database — Decision Room source reads (ACBP-P6-008; CDR-076; DEC-001, ACT-003/004; invariant 20).
//
// READ-ONLY. Every method below is a narrow, typed SELECT over a surface that already exists, executed on the
// caller's CompanyScope transaction so RLS confines each row to the current account + company. Nothing here
// composes queues — that is the service's job (CDR-076 §3-G4 runs each SECTION in its own savepoint, and a
// repository that quietly merged sources would take that boundary away from it).
//
// TWO PROPERTIES ARE STRUCTURAL HERE RATHER THAN CONVENTIONAL:
//
//  1. INVARIANT 20 (trust-critical #18). {@link DecisionRoomRepository.completedTasksWithRunEvidence} requires an
//     EXISTS over a company-pinned SUCCEEDED run, so a `completed` task with no run record cannot be returned at
//     all. EXISTS rather than a join: a join against runs fans out if a task ever carries two succeeded attempts,
//     and an inflated "results" count is its own species of lie. The completions the evidence predicate excludes
//     are not lost — {@link DecisionRoomRepository.unverifiedCompletionCount} counts them (CDR-076 §3-G3).
//
//  2. THE TRUE TOTAL TRAVELS WITH THE CAPPED SAMPLE. Every list returns `count(*) over ()`, which PostgreSQL
//     evaluates BEFORE `LIMIT`, so a section can render 20 items and still report that 4,000 are waiting. A count
//     derived from `rows.length` would silently cap the number the founder actually acts on.
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from './schema.js';

export type DecisionRoomExecutor = Kysely<DatabaseSchema>;

/** The pre-LIMIT row count, carried on every returned row (see the header note). */
type WithTotal = { readonly total_count: string };

/** `count(*) over ()` — the total the query WOULD have returned without its LIMIT. */
const TOTAL = sql<string>`count(*) over ()`;

/** A list result: the capped sample plus the true pre-LIMIT total. */
export interface DecisionRoomList<T> {
  readonly rows: readonly T[];
  readonly total: number;
}

function toList<T extends WithTotal>(rows: T[]): DecisionRoomList<T> {
  // Zero rows means zero total: the window function produces no row to read it from, and defaulting to 0 here is
  // correct rather than convenient — an empty result set genuinely has nothing behind the LIMIT.
  return { rows, total: rows.length === 0 ? 0 : Number(rows[0]?.total_count ?? 0) };
}

export interface ApprovalRequestSummaryRow extends WithTotal {
  readonly id: string;
  readonly action: string;
  readonly risk_class: string;
  readonly scope: string;
  readonly estimated_cost_credits: number;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly status: string;
}

export interface ApprovalDecisionSummaryRow extends WithTotal {
  readonly id: string;
  readonly path: string;
  readonly decider_type: string;
  readonly decided_at: Date;
  readonly action: string;
}

export interface HeldWorkSummaryRow extends WithTotal {
  readonly id: string;
  readonly task_id: string;
  readonly title: string;
  readonly held_at: Date;
}

export interface TaskSummaryRow extends WithTotal {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly task_type: string | null;
  readonly priority: number | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface FailedTaskRow extends TaskSummaryRow {
  readonly latest_failure_category: string | null;
}

export interface CompletedTaskRow extends TaskSummaryRow {
  readonly artifact_count: string;
}

export interface OpenQuestionRow extends WithTotal {
  readonly id: string;
  readonly prompt: string;
  readonly position: number;
  readonly source: string;
  readonly created_at: Date;
}

export interface StrategyOptionSummaryRow extends WithTotal {
  readonly id: string;
  readonly ordinal: number;
  readonly fields: Record<string, string>;
  readonly created_at: Date;
}

export interface StrategyDecisionSummaryRow extends WithTotal {
  readonly id: string;
  readonly mode: string;
  readonly created_at: Date;
}

/** The company's own usage totals (ACT-004). Sums, not a rollup read: `account_usage_rollups` is account-keyed. */
export interface CompanyUsageTotals {
  readonly eventCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostMicros: number;
}

/**
 * Company-scoped Decision Room source reads. Constructed with the caller's CompanyScope transaction executor;
 * every method additionally pins `company_id` explicitly — defense in depth behind RLS, and the same posture
 * {@link ActivityFeedRepository} takes.
 */
export class DecisionRoomRepository {
  readonly #db: DecisionRoomExecutor;
  readonly #companyId: string;

  constructor(db: DecisionRoomExecutor, companyId: string) {
    this.#db = db;
    this.#companyId = companyId;
  }

  /**
   * Approvals awaiting a human (DEC-001 "needs your decision"). `now` is passed in rather than read from the
   * database clock so the caller's single snapshot instant governs every section — and an already-expired request
   * is NOT waiting for anyone, so it is excluded rather than shown as actionable.
   */
  async pendingApprovals(now: Date, limit: number): Promise<DecisionRoomList<ApprovalRequestSummaryRow>> {
    const rows = await this.#db
      .selectFrom('approval_requests')
      .select(['id', 'action', 'risk_class', 'scope', 'estimated_cost_credits', 'created_at', 'expires_at', 'status'])
      .select(TOTAL.as('total_count'))
      .where('company_id', '=', this.#companyId)
      .where('status', '=', 'pending')
      .where('expires_at', '>', now)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return toList(rows as ApprovalRequestSummaryRow[]);
  }

  /**
   * Authorized but not yet spent (DEC-001 "approved and queued"): decided, still usable, never consumed. A
   * revoked or expired authorization is deliberately absent — it authorizes nothing, so presenting it as queued
   * work would tell the founder something is about to happen when nothing is.
   */
  async decidedUnconsumedApprovals(now: Date, limit: number): Promise<DecisionRoomList<ApprovalRequestSummaryRow>> {
    const rows = await this.#db
      .selectFrom('approval_requests')
      .select(['id', 'action', 'risk_class', 'scope', 'estimated_cost_credits', 'created_at', 'expires_at', 'status'])
      .select(TOTAL.as('total_count'))
      .where('company_id', '=', this.#companyId)
      .where('status', '=', 'decided')
      .where('consumed_at', 'is', null)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now)
      .orderBy('decided_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return toList(rows as ApprovalRequestSummaryRow[]);
  }

  /** Decisions already taken (DEC-001 "recent decisions"), newest first, with the action they were about. */
  async recentApprovalDecisions(limit: number): Promise<DecisionRoomList<ApprovalDecisionSummaryRow>> {
    const rows = await this.#db
      .selectFrom('approval_decisions as d')
      .innerJoin('approval_requests as r', (join) => join.onRef('r.id', '=', 'd.request_id').onRef('r.company_id', '=', 'd.company_id'))
      .select(['d.id as id', 'd.path as path', 'd.decider_type as decider_type', 'd.decided_at as decided_at', 'r.action as action'])
      .select(TOTAL.as('total_count'))
      .where('d.company_id', '=', this.#companyId)
      .orderBy('d.decided_at', 'desc')
      .orderBy('d.id', 'desc')
      .limit(limit)
      .execute();
    return toList(rows as ApprovalDecisionSummaryRow[]);
  }

  /**
   * Work an emergency stop is holding, still awaiting review (ADMIN-002). `confirmed`/`discarded` rows are
   * reviewed history, not a queue — held work that has been ruled on is no longer blocking a decision.
   */
  async heldWork(limit: number): Promise<DecisionRoomList<HeldWorkSummaryRow>> {
    const rows = await this.#db
      .selectFrom('held_work as h')
      .innerJoin('tasks as t', (join) => join.onRef('t.id', '=', 'h.task_id').onRef('t.company_id', '=', 'h.company_id'))
      .select(['h.id as id', 'h.task_id as task_id', 't.title as title', 'h.held_at as held_at'])
      .select(TOTAL.as('total_count'))
      .where('h.company_id', '=', this.#companyId)
      .where('h.status', '=', 'held')
      .orderBy('h.held_at', 'desc')
      .orderBy('h.id', 'desc')
      .limit(limit)
      .execute();
    return toList(rows as HeldWorkSummaryRow[]);
  }

  /** Tasks in any of `states`, newest-updated first. The generic source behind several queues. */
  async tasksByStates(states: readonly string[], limit: number): Promise<DecisionRoomList<TaskSummaryRow>> {
    if (states.length === 0) return { rows: [], total: 0 };
    const rows = await this.#db
      .selectFrom('tasks')
      .select(['id', 'title', 'state', 'task_type', 'priority', 'created_at', 'updated_at'])
      .select(TOTAL.as('total_count'))
      .where('company_id', '=', this.#companyId)
      .where('state', 'in', states)
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return toList(rows as TaskSummaryRow[]);
  }

  /** Planner-proposed work (DEC-001 "recommended next actions"): `planned`, in planning rank order (0 = first). */
  async plannedTasksByPriority(limit: number): Promise<DecisionRoomList<TaskSummaryRow>> {
    const rows = await this.#db
      .selectFrom('tasks')
      .select(['id', 'title', 'state', 'task_type', 'priority', 'created_at', 'updated_at'])
      .select(TOTAL.as('total_count'))
      .where('company_id', '=', this.#companyId)
      .where('state', '=', 'planned')
      // NULLS LAST: an unranked task is not rank 0. Sorting it first would present "not stated" as "do this next".
      .orderBy(sql`priority asc nulls last`)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
    return toList(rows as TaskSummaryRow[]);
  }

  /**
   * INVARIANT 20 (trust-critical #18). Completed tasks THAT HAVE A SUCCEEDED RUN — the evidence is an EXISTS in
   * the WHERE clause, so this method structurally cannot return an unevidenced completion. See the header for
   * why EXISTS rather than a join.
   */
  async completedTasksWithRunEvidence(limit: number): Promise<DecisionRoomList<CompletedTaskRow>> {
    const rows = await this.#db
      .selectFrom('tasks')
      .select(['id', 'title', 'state', 'task_type', 'priority', 'created_at', 'updated_at'])
      .select(TOTAL.as('total_count'))
      .select((eb) =>
        eb
          .selectFrom('artifacts')
          .innerJoin('task_runs', (join) => join.onRef('task_runs.id', '=', 'artifacts.run_id').onRef('task_runs.company_id', '=', 'artifacts.company_id'))
          .select((inner) => inner.fn.countAll<string>().as('c'))
          .whereRef('task_runs.task_id', '=', 'tasks.id')
          .whereRef('task_runs.company_id', '=', 'tasks.company_id')
          .as('artifact_count'),
      )
      .where('company_id', '=', this.#companyId)
      .where('state', '=', 'completed')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('task_runs')
            .select('task_runs.id')
            .whereRef('task_runs.task_id', '=', 'tasks.id')
            .whereRef('task_runs.company_id', '=', 'tasks.company_id')
            .where('task_runs.state', '=', 'succeeded'),
        ),
      )
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return toList(rows as CompletedTaskRow[]);
  }

  /**
   * The counterpart to the evidence predicate: how many completions it EXCLUDED. Expected 0. A non-zero value is
   * a data-integrity signal, and surfacing it is what stops "invariant 20 enforced" from quietly meaning
   * "completed work disappeared" (CDR-076 §3-G3).
   */
  async unverifiedCompletionCount(): Promise<number> {
    const row = await this.#db
      .selectFrom('tasks')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .where('company_id', '=', this.#companyId)
      .where('state', '=', 'completed')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('task_runs')
              .select('task_runs.id')
              .whereRef('task_runs.task_id', '=', 'tasks.id')
              .whereRef('task_runs.company_id', '=', 'tasks.company_id')
              .where('task_runs.state', '=', 'succeeded'),
          ),
        ),
      )
      .executeTakeFirst();
    return Number(row?.c ?? 0);
  }

  /** Failed tasks with the CLOSED failure category of their latest attempt (never worker exception text). */
  async failedTasks(limit: number): Promise<DecisionRoomList<FailedTaskRow>> {
    const rows = await this.#db
      .selectFrom('tasks')
      .select(['id', 'title', 'state', 'task_type', 'priority', 'created_at', 'updated_at'])
      .select(TOTAL.as('total_count'))
      .select((eb) =>
        eb
          .selectFrom('task_runs')
          .select('task_runs.failure_category')
          .whereRef('task_runs.task_id', '=', 'tasks.id')
          .whereRef('task_runs.company_id', '=', 'tasks.company_id')
          .orderBy('task_runs.attempt', 'desc')
          .limit(1)
          .as('latest_failure_category'),
      )
      .where('company_id', '=', this.#companyId)
      .where('state', '=', 'failed')
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return toList(rows as FailedTaskRow[]);
  }

  /**
   * Questions the AI team asked and nobody has answered (DEC-001 "questions from the AI team"). "Open" is the
   * ABSENCE of an answer row, because that is how the interview models it — the question table has no state
   * column, and inventing one here would put a second, disagreeing definition of "answered" in the codebase.
   */
  async openInterviewQuestions(limit: number): Promise<DecisionRoomList<OpenQuestionRow>> {
    const rows = await this.#db
      .selectFrom('interview_questions as q')
      .select(['q.id as id', 'q.prompt as prompt', 'q.position as position', 'q.source as source', 'q.created_at as created_at'])
      .select(TOTAL.as('total_count'))
      .where('q.company_id', '=', this.#companyId)
      .where((eb) => eb.not(eb.exists(eb.selectFrom('interview_answers as a').select('a.question_id').whereRef('a.question_id', '=', 'q.id').whereRef('a.company_id', '=', 'q.company_id'))))
      .orderBy('q.created_at', 'desc')
      .orderBy('q.id', 'desc')
      .limit(limit)
      .execute();
    return toList(rows as OpenQuestionRow[]);
  }

  /**
   * The latest strategy generation IF it has not been decided yet. Returns null when there is no generation, or
   * when the latest one already has a decision record — in both cases nothing is "under consideration".
   */
  async latestUndecidedGenerationId(): Promise<string | null> {
    const row = await this.#db
      .selectFrom('strategy_generations as g')
      .select('g.id as id')
      .where('g.company_id', '=', this.#companyId)
      .where((eb) => eb.not(eb.exists(eb.selectFrom('decisions as d').select('d.id').whereRef('d.generation_id', '=', 'g.id').whereRef('d.company_id', '=', 'g.company_id'))))
      .orderBy('g.created_at', 'desc')
      .orderBy('g.id', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  /** The options of one generation, in presentation order. */
  async optionsForGeneration(generationId: string, limit: number): Promise<DecisionRoomList<StrategyOptionSummaryRow>> {
    const rows = await this.#db
      .selectFrom('strategy_options')
      .select(['id', 'ordinal', 'fields', 'created_at'])
      .select(TOTAL.as('total_count'))
      .where('company_id', '=', this.#companyId)
      .where('generation_id', '=', generationId)
      .orderBy('ordinal', 'asc')
      .limit(limit)
      .execute();
    return toList(rows as StrategyOptionSummaryRow[]);
  }

  /** Immutable owner strategy decisions (DEC-001 "recent decisions", alongside the approval decisions). */
  async recentStrategyDecisions(limit: number): Promise<DecisionRoomList<StrategyDecisionSummaryRow>> {
    const rows = await this.#db
      .selectFrom('decisions')
      .select(['id', 'mode', 'created_at'])
      .select(TOTAL.as('total_count'))
      .where('company_id', '=', this.#companyId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return toList(rows as StrategyDecisionSummaryRow[]);
  }

  /**
   * ACT-004: THIS COMPANY'S usage totals. Summed from `usage_events`, which is dual-keyed to account AND company,
   * so the figure is this company's alone — no account-wide total is reachable from a company-scoped room
   * (CDR-076 §3-G8). Sums are coalesced to 0: no usage is a real answer, not a missing one.
   */
  async companyUsageTotals(): Promise<CompanyUsageTotals> {
    const row = await this.#db
      .selectFrom('usage_events')
      .select((eb) => [
        eb.fn.countAll<string>().as('event_count'),
        eb.fn.coalesce(eb.fn.sum<string>('input_tokens'), sql<string>`0`).as('input_tokens'),
        eb.fn.coalesce(eb.fn.sum<string>('output_tokens'), sql<string>`0`).as('output_tokens'),
        eb.fn.coalesce(eb.fn.sum<string>('estimated_cost_micros'), sql<string>`0`).as('estimated_cost_micros'),
      ])
      .where('company_id', '=', this.#companyId)
      .executeTakeFirst();
    return {
      eventCount: Number(row?.event_count ?? 0),
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      estimatedCostMicros: Number(row?.estimated_cost_micros ?? 0),
    };
  }
}
