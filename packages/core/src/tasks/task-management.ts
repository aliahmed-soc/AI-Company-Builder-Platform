// @acbp/core — task use cases (ACBP-P4-002; CDR-033 §2/§4; TASK-001; ADR-008; WORKFLOW-STATE-MACHINES §4).
//
// The effect-free pre-execution slice of the server-enforced task state machine. Five use cases, each run in a FRESH
// company scope (server-resolved account/company/actor; company-membership authz; dual-keyed RLS):
//   - createTask       — mint a task in `draft` (no audit yet; a draft is not on the board);
//   - planTask         — the server-enforced draft→planned "appears on the board" transition, `task.created` audited
//                        in-tx (audit-or-nothing). EVERY illegal (from,to) is rejected with NO audit (TASK-001).
//   - addTaskDependency— an immutable, same-company Task↔Task edge; refuses self / duplicate / unknown edges;
//   - getTask/listTasks— the redacted board reads (owner+viewer).
// The execution transitions (planned→queued credit reservation, running/holds, terminals) are DEFINED-legal in the
// contract but their EFFECTS belong to later P5/P6 tickets — this ticket implements only create→draft and draft→planned
// (the `interview.ts` precedent). No content or PII in any audit metadata; only `{has_milestone}`.
import { TaskRepository, writeAuditEvent, type DatabaseClient, type AuditScope, type AuditWriteContext, type TaskRow } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import { taskCreated, isLegalTaskTransition, toTaskDisplayPhase, isTaskState, TASK_TITLE_MAX, TASK_DESCRIPTION_MAX, type AuditEvent, type TaskDTO, type TaskState } from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

type AuditWriteFn = (scope: AuditScope, event: AuditEvent, ctx?: AuditWriteContext) => Promise<string>;

export interface TaskOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  /** TEST SEAM ONLY: override the in-tx audit writer to force a failure (prove the write rolls back). */
  readonly auditWriter?: AuditWriteFn;
}

/** Map a persisted task row to the redacted client DTO (approved fields only; honest display phase). */
export function toTaskDTO(row: TaskRow): TaskDTO {
  const state: TaskState = isTaskState(row.state) ? row.state : 'draft'; // DB CHECK guarantees in-set; defensive
  return {
    taskId: row.id,
    companyId: row.company_id,
    state,
    phase: toTaskDisplayPhase(row.state),
    title: row.title,
    description: row.description,
    milestoneId: row.milestone_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

// ── createTask ───────────────────────────────────────────────────────────────────────────────────────────
export interface CreateTaskParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly title: string;
  readonly description?: string | null;
  readonly milestoneId?: string | null;
}
export type CreateTaskResult = { readonly status: 'ok'; readonly task: TaskDTO } | { readonly status: 'forbidden' } | { readonly status: 'invalid' };

/**
 * Create a task, minted server-side in `draft` (INITIAL_TASK_STATE). Company-scoped; owner|viewer (`task:create`).
 * Validates the bounded title (1..TASK_TITLE_MAX after trim) and optional description (null or 1..TASK_DESCRIPTION_MAX).
 * NO audit event: a draft is not yet on the board — `task.created` is written by `planTask` (CDR-033 §4).
 */
export async function createTask(client: DatabaseClient, params: CreateTaskParams, options: TaskOptions = {}): Promise<CreateTaskResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<CreateTaskResult> => {
      if (checkAuthorization(role, 'task:create', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const title = params.title.trim();
      if (title.length === 0 || title.length > TASK_TITLE_MAX) return { status: 'invalid' };
      // Trim the description consistently with the title; a blank description collapses to null.
      const trimmedDesc = params.description?.trim() ?? '';
      const description = trimmedDesc.length === 0 ? null : trimmedDesc;
      if (description !== null && description.length > TASK_DESCRIPTION_MAX) return { status: 'invalid' };

      const row = await new TaskRepository(scope.db).insert({
        accountId: params.accountId,
        companyId: params.companyId,
        title,
        description,
        milestoneId: params.milestoneId ?? null,
        createdByUserId: params.userId,
      });
      options.logger?.info('task.created_draft', { metadata: { accountId: params.accountId, companyId: params.companyId, hasMilestone: row.milestone_id !== null } });
      return { status: 'ok', task: toTaskDTO(row) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── planTask (server-enforced draft→planned; task.created audited) ───────────────────────────────────────
export interface PlanTaskParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly taskId: string;
}
export type PlanTaskResult =
  | { readonly status: 'ok'; readonly task: TaskDTO }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'illegal_transition'; readonly from: TaskState; readonly to: TaskState };

/**
 * The board-appearance transition (`draft → planned`), SERVER-ENFORCED against the legal-transition map: an illegal
 * `(from, 'planned')` (a non-draft task — already planned, held, running, or terminal) is REJECTED with no state change
 * and no audit (TASK-001 "invalid transitions are rejected"). The `state=fromState` guard makes the update race-safe
 * (exactly one plan wins). `task.created` is written in the SAME transaction (audit-or-nothing).
 */
export async function planTask(client: DatabaseClient, params: PlanTaskParams, options: TaskOptions = {}): Promise<PlanTaskResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const to: TaskState = 'planned';
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<PlanTaskResult> => {
      if (checkAuthorization(role, 'task:create', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const tasks = new TaskRepository(scope.db);
      const task = await tasks.findById(params.taskId);
      if (task === undefined) return { status: 'not_found' };
      const from: TaskState = isTaskState(task.state) ? task.state : 'draft';
      if (!isLegalTaskTransition(from, to)) return { status: 'illegal_transition', from, to };

      const updated = await tasks.updateState(params.taskId, from, to);
      if (updated === 0) return { status: 'illegal_transition', from, to }; // raced: the row left `from` before we advanced it
      await audit(scope, taskCreated({ taskId: params.taskId, hasMilestone: task.milestone_id !== null }), auditCtx(options));
      options.logger?.info('task.created', { metadata: { accountId: params.accountId, companyId: params.companyId, hasMilestone: task.milestone_id !== null } });
      const fresh = await tasks.findById(params.taskId);
      return { status: 'ok', task: toTaskDTO(fresh ?? { ...task, state: to }) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── addTaskDependency (immutable same-company edge) ──────────────────────────────────────────────────────
export interface AddDependencyParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly taskId: string;
  readonly dependsOnTaskId: string;
}
export type AddDependencyResult =
  | { readonly status: 'ok'; readonly dependencyId: string }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'invalid' }
  | { readonly status: 'duplicate' };

/**
 * Add an immutable Task↔Task dependency edge (`task_id depends_on depends_on_task_id`). `task:depend` folds into
 * `task:create` (CDR-033 §4). Refuses a self-dependency (`invalid`), a target task that is absent/invisible to the
 * caller's company scope (`not_found` — cross-company is impossible: both FKs + the dual key confine to one company),
 * and a duplicate edge (`duplicate`). Append-only; there is no update/delete path.
 */
export async function addTaskDependency(client: DatabaseClient, params: AddDependencyParams, options: TaskOptions = {}): Promise<AddDependencyResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<AddDependencyResult> => {
      if (checkAuthorization(role, 'task:create', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      if (params.taskId === params.dependsOnTaskId) return { status: 'invalid' };
      const tasks = new TaskRepository(scope.db);
      // Both endpoints must be visible in THIS company scope (RLS-confined findById).
      if ((await tasks.findById(params.taskId)) === undefined) return { status: 'not_found' };
      if ((await tasks.findById(params.dependsOnTaskId)) === undefined) return { status: 'not_found' };

      // Race-safe: the DB's ON CONFLICT DO NOTHING (not a check-then-insert) is the single source of duplicate truth —
      // a concurrent identical edge returns undefined here rather than throwing a UNIQUE violation.
      const edge = await tasks.insertDependency({ accountId: params.accountId, companyId: params.companyId, taskId: params.taskId, dependsOnTaskId: params.dependsOnTaskId });
      if (edge === undefined) return { status: 'duplicate' };
      options.logger?.info('task.dependency_added', { metadata: { accountId: params.accountId, companyId: params.companyId } });
      return { status: 'ok', dependencyId: edge.id };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── getTask / listTasks (redacted board reads) ───────────────────────────────────────────────────────────
export interface GetTaskParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly taskId: string;
}
export type GetTaskResult = { readonly status: 'ok'; readonly task: TaskDTO } | { readonly status: 'forbidden' } | { readonly status: 'not_found' };

/** Read a single task as the redacted DTO (owner+viewer, `task:read`). RLS-confined — a foreign task is `not_found`. */
export async function getTask(client: DatabaseClient, params: GetTaskParams, options: TaskOptions = {}): Promise<GetTaskResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<GetTaskResult> => {
      if (checkAuthorization(role, 'task:read', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const row = await new TaskRepository(scope.db).findById(params.taskId);
      return row === undefined ? { status: 'not_found' } : { status: 'ok', task: toTaskDTO(row) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

export interface ListTasksParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly limit?: number;
}
export type ListTasksResult = { readonly status: 'ok'; readonly tasks: readonly TaskDTO[] } | { readonly status: 'forbidden' };

/** List the company's tasks as redacted DTOs, newest first, bounded (owner+viewer, `task:read`). RLS-confined. */
export async function listTasks(client: DatabaseClient, params: ListTasksParams, options: TaskOptions = {}): Promise<ListTasksResult> {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 200);
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ListTasksResult> => {
      if (checkAuthorization(role, 'task:read', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const rows = await new TaskRepository(scope.db).list({ limit });
      return { status: 'ok', tasks: rows.map(toTaskDTO) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────
function auditCtx(options: TaskOptions): AuditWriteContext {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}
function opts(options: TaskOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}
