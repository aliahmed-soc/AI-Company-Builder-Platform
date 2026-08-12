// @acbp/core — task detail + repeat/delete controls (ACBP-P4-005; CDR-043; TASK-002/TASK-008; ADR-008).
//
// Three use cases, each run in a FRESH company scope (server-resolved account/company/actor; company-membership authz;
// dual-keyed RLS):
//   - getTaskDetail — TASK-002's detail view: the approved fields, nothing defaulted, plus the DERIVED control set;
//   - repeatTask    — TASK-008's "re-queued as a NEW task": a new `draft` row linked to its source, `task.repeated`;
//   - deleteTask    — TASK-008's confirmed, audited delete: an append-only record, `task.deleted`.
//
// DELETE IS NOT A `DELETE`. `tasks` carries no DELETE grant and its column UPDATE is pinned to (state, updated_at);
// widening either to make this convenient would destroy the audit trail TASK-008 itself demands (CDR-043 §3). So a
// deletion is a row in the append-only `task_deletions` table and every product read excludes it.
import { TaskRepository, TaskRunRepository, writeAuditEvent, type DatabaseClient, type AuditWriteContext, type TaskRow, type TaskRunExecutor } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import { buildTaskDetail, controlAvailability, describeRunFailure, taskRepeated, taskDeleted, isTaskState, type RunFailureDetail, type ControlUnavailableReason, type TaskDetailDTO, type TaskDTO, type TaskState } from '@acbp/contracts';
import { toTaskDTO, type TaskOptions } from './task-management.js';
import type { Logger } from '@acbp/observability';

/** The owner's optional note on a deletion. Bounded here to match the DB CHECK, so an over-long note is `invalid`. */
export const TASK_DELETE_REASON_MAX = 2_000;

/**
 * Assemble the detail DTO from a row. The control set is derived from the row's own state, never stored — and so is
 * the failure detail (ACBP-P5-013): both are computed from facts the row already carries, so neither can go stale.
 */
function toTaskDetailDTO(row: TaskRow, latestFailure: RunFailureDetail | null): TaskDetailDTO {
  return buildTaskDetail(toTaskDTO(row), { rationale: row.rationale, repeatedFromTaskId: row.repeated_from_task_id, latestFailure });
}

/**
 * The failure detail of a task's most recent run, or `null` if it has none or the latest did not fail.
 *
 * THE LATEST RUN ONLY. A task that failed twice and then succeeded has not failed — showing the older failure would
 * be a stale answer to "what is wrong with this task", and TASK-006 is about the founder's current picture.
 * `listForTask` returns newest first (P5-002), and RLS confines it to the caller's company.
 */
async function latestFailureFor(db: TaskRunExecutor, taskId: string, taskState: string): Promise<RunFailureDetail | null> {
  const runs = await new TaskRunRepository(db).listForTask(taskId);
  const latest = runs[0];
  const fromLatest = latest === undefined ? null : describeRunFailure({ state: latest.state, failureCategory: latest.failure_category, attempt: latest.attempt });
  if (fromLatest !== null) return fromLatest;

  // A FAILED TASK ALWAYS EXPLAINS ITSELF. Review pass 1: nothing ties `tasks.state = 'failed'` to a failed RUN —
  // `running → failed` is a legal task transition on its own, a task can fail with no run at all, and a later
  // attempt may be queued or cancelled. Every one of those put a task in the board's `failed` bucket with a blank
  // explanation, which is the single thing TASK-006 forbids. So the task's own state is the backstop: if it says
  // failed and no run accounts for it, the cause is genuinely unknown and we say so.
  if (taskState !== 'failed') return null;
  const failedRun = runs.find((r) => r.state === 'failed');
  return describeRunFailure({
    state: 'failed',
    failureCategory: failedRun?.failure_category ?? null,
    attempt: failedRun?.attempt ?? runs[0]?.attempt ?? 1,
  });
}

// ── getTaskDetail ────────────────────────────────────────────────────────────────────────────────────────
export interface GetTaskDetailParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly taskId: string;
}
export type GetTaskDetailResult = { readonly status: 'ok'; readonly task: TaskDetailDTO } | { readonly status: 'forbidden' } | { readonly status: 'not_found' };

/**
 * TASK-002's detail view (owner+viewer, `task:read`). RLS-confined — a foreign task is `not_found`.
 *
 * Reads through `findLive`, so a DELETED task is `not_found` rather than a viewable record: the row survives for the
 * audit trail, but to the product the task is gone (CDR-043 §4-G9). Missing fields stay missing — nothing is defaulted
 * (TASK-002's failure clause).
 */
export async function getTaskDetail(client: DatabaseClient, params: GetTaskDetailParams, options: TaskOptions = {}): Promise<GetTaskDetailResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<GetTaskDetailResult> => {
      if (checkAuthorization(role, 'task:read', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const row = await new TaskRepository(scope.db).findLive(params.taskId);
      // MUTATION M-ORACLE-B (DO NOT MERGE) — DESIGNED TO SURVIVE, NOT TO KILL. Collapses the task-level
      // not_found into forbidden. G-oracle(b) asserts a FOREIGN task id and an UNKNOWN one are byte-identical;
      // this seam cannot separate them, because RLS already made both `undefined` before this line runs. So
      // G-oracle(b) is expected to stay GREEN while the not_found-vs-forbidden distinctness test goes RED.
      // A survival here is the EVIDENCE that the guard is structurally unmeasurable rather than merely unrun.
      if (row === undefined) return { status: 'forbidden' };
      // TASK-006: the failure a founder needs to see belongs to the RUN, and this is where they look for it.
      return { status: 'ok', task: toTaskDetailDTO(row, await latestFailureFor(scope.db, params.taskId, row.state)) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── repeatTask ───────────────────────────────────────────────────────────────────────────────────────────
export interface RepeatTaskParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly taskId: string;
}
export type RepeatTaskResult =
  | { readonly status: 'ok'; readonly task: TaskDTO; readonly sourceTaskId: string }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  // The CLOSED reason union, not a bare string: a caller rendering "why not" must be able to switch exhaustively,
  // and an open string would make this an unreviewable message surface.
  | { readonly status: 'unavailable'; readonly reason: ControlUnavailableReason };

/**
 * TASK-008's repeat: "re-queued as a NEW task" (owner+viewer, `task:create` — repeat mints a task, which is exactly
 * what that action authorizes).
 *
 * A NEW ROW, never a state rewind (CDR-043 §4-G4). Rewinding would erase the original's history, which is the opposite
 * of what an owner repeating a FAILED task wants: they need to see that it failed once. The new task is minted in
 * `draft`, the canon-native minting state, so it appears on the board only when confirmed like any other new task.
 *
 * CONTENT is copied; PROVENANCE and OUTCOME are not (G5). Title, description, type and milestone carry over; the
 * source's `priority` and `rationale` do not — attributing a model's reasoning about one task to a different task is
 * the fabrication ADR-019 forbids, and a repeat has not been ranked by any planning run.
 *
 * Only a FINISHED task can be repeated, and the refusal names why. Repeating live work would silently create a second
 * task doing the same thing. A DELETED source is `not_found` (G6) — a discarded task must not be revivable through a
 * link.
 */
export async function repeatTask(client: DatabaseClient, params: RepeatTaskParams, options: TaskOptions = {}): Promise<RepeatTaskResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<RepeatTaskResult> => {
      if (checkAuthorization(role, 'task:create', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const tasks = new TaskRepository(scope.db);
      // findLive, not findById: a deleted source is gone to the product, so repeating it is not_found (G6).
      const source = await tasks.findLive(params.taskId);
      if (source === undefined) return { status: 'not_found' };

      // The SAME projection the detail view shows, so the button a UI renders and the answer it gets can never
      // disagree. Computing availability a second way here is how those two drift apart.
      const verdict = controlAvailability(source.state).find((v) => v.control === 'repeat');
      if (verdict === undefined || !verdict.available) return { status: 'unavailable', reason: verdict?.reason ?? 'unknown_state' };

      const created = await tasks.insert({
        accountId: params.accountId,
        companyId: params.companyId,
        title: source.title,
        description: source.description,
        milestoneId: source.milestone_id,
        taskType: source.task_type,
        // priority + rationale deliberately omitted — see G5 above. They default to null.
        repeatedFromTaskId: source.id,
        createdByUserId: params.userId,
      });

      // Audit-or-nothing: the event and the row are one transaction (ADR-015). Scalars only — the new task id, the
      // source id and the source's state. No title, no description.
      await audit(scope, taskRepeated({ newTaskId: created.id, sourceTaskId: source.id, sourceState: source.state }), auditCtx(options));
      options.logger?.info('task.repeated', { metadata: { accountId: params.accountId, companyId: params.companyId, sourceState: source.state } });
      return { status: 'ok', task: toTaskDTO(created), sourceTaskId: source.id };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── deleteTask ───────────────────────────────────────────────────────────────────────────────────────────
export interface DeleteTaskParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly taskId: string;
  /**
   * TASK-008's "with confirmation for delete", made explicit (CDR-043 §4-G3). A core use case has no UI, so the honest
   * encoding of "requires confirmation" is a required acknowledgement the caller must pass — not a comment saying the
   * UI ought to ask. This makes an unconfirmed delete impossible to perform by accident from ANY caller.
   */
  readonly confirmed: boolean;
  /** The owner's optional note. Stored on the deletion record; NEVER placed in the audit payload. */
  readonly reason?: string | null;
}
export type DeleteTaskResult =
  | { readonly status: 'ok'; readonly taskId: string; readonly stateAtDelete: TaskState }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'confirmation_required' }
  | { readonly status: 'invalid' }
  // The CLOSED reason union, not a bare string: a caller rendering "why not" must be able to switch exhaustively,
  // and an open string would make this an unreviewable message surface.
  | { readonly status: 'unavailable'; readonly reason: ControlUnavailableReason };

/**
 * TASK-008's delete: confirmed, refused while in-flight, and audited (owner+viewer, `task:delete`).
 *
 * NOT a row deletion. The task row survives and a row is appended to `task_deletions`; every product read excludes it
 * (CDR-043 §3). That is what keeps "delete ... is audited" true — a real DELETE would remove the evidence.
 *
 * A RUNNING task is refused with `cancel_first`, TASK-008's own remedy wording, extended to the four hold states
 * because a task awaiting an approval is equally mid-flight (G2). Deleting is IDEMPOTENT: `ON CONFLICT (task_id) DO
 * NOTHING` in the repository means a second delete is the same fact rather than a second record, and it returns
 * `not_found` because to the caller the task is already gone.
 */
export async function deleteTask(client: DatabaseClient, params: DeleteTaskParams, options: TaskOptions = {}): Promise<DeleteTaskResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<DeleteTaskResult> => {
      if (checkAuthorization(role, 'task:delete', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      // Checked BEFORE the task is read: an unconfirmed delete must not even be able to probe whether a task exists.
      if (params.confirmed !== true) return { status: 'confirmation_required' };

      const trimmed = params.reason?.trim() ?? '';
      const reason = trimmed.length === 0 ? null : trimmed;
      if (reason !== null && reason.length > TASK_DELETE_REASON_MAX) return { status: 'invalid' };

      const tasks = new TaskRepository(scope.db);
      const task = await tasks.findLive(params.taskId);
      if (task === undefined) return { status: 'not_found' }; // absent, foreign, or already deleted

      const verdict = controlAvailability(task.state).find((v) => v.control === 'delete');
      if (verdict === undefined || !verdict.available) return { status: 'unavailable', reason: verdict?.reason ?? 'unknown_state' };

      const record = await tasks.insertDeletion({
        accountId: params.accountId,
        companyId: params.companyId,
        taskId: task.id,
        stateAtDelete: task.state,
        reason,
        deletedByUserId: params.userId,
      });
      // The guarded insert wrote nothing. Two different things can cause that, and they need different answers, so
      // re-read rather than guessing: either someone else deleted the task first (already gone), or it CHANGED STATE
      // in the window between the read above and the write — the queued→running case G2 exists to refuse. Reporting
      // `ok` here would claim a deletion that never happened and emit an audit event to match.
      if (record === undefined) {
        if ((await tasks.findDeletion(params.taskId)) !== undefined) return { status: 'not_found' };
        const now = await tasks.findLive(params.taskId);
        if (now === undefined) return { status: 'not_found' };
        const recheck = controlAvailability(now.state).find((v) => v.control === 'delete');
        // It moved. If the new state still permits deletion the caller may simply retry; `cancel_first` is the honest
        // default because a state change out from under a delete means the task started moving.
        return { status: 'unavailable', reason: recheck?.available === false ? recheck.reason ?? 'cancel_first' : 'cancel_first' };
      }

      // Audit-or-nothing (ADR-015). `has_reason` is a BOOLEAN: whether the owner explained themselves is useful, the
      // free text they wrote is theirs and stays out of the audit payload entirely.
      await audit(scope, taskDeleted({ taskId: task.id, stateAtDelete: task.state, hasReason: reason !== null }), auditCtx(options));
      options.logger?.info('task.deleted', { metadata: { accountId: params.accountId, companyId: params.companyId, stateAtDelete: task.state, hasReason: reason !== null } });
      // The DB CHECK confines state_at_delete to the eleven states; the narrow is defensive, matching toTaskDTO.
      return { status: 'ok', taskId: task.id, stateAtDelete: isTaskState(task.state) ? task.state : 'draft' };
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
