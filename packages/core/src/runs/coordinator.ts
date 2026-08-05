// @acbp/core — the workflow coordinator (ACBP-P5-002; CDR-053; TASK-007; NFR-005; ADR-008).
//
// A RUN IS ONE EXECUTION ATTEMPT of a task. This module owns the run's lifecycle and nothing else: task-state
// transitions remain P4-002's `transitionTask`, and the policy that decides whether work may proceed is P6's. What
// lives here is the mechanism — start, liveness, terminal outcome, and the two distinct kinds of cancellation.
//
// EVERY MUTATION IS GUARDED on the state the caller believed the run was in. A coordinator, a worker and an owner can
// all act on one run at the same moment, and the guard is what turns "someone else already decided" into a reported
// outcome instead of a silent overwrite.
import { TaskRunRepository, TaskRepository, WorkerRunRepository, writeAuditEvent, projectCompanyActivity, type DatabaseClient, type AuditWriteContext, type TaskRunRow, type ActivityWriteFn } from '@acbp/database';
import {
  canStartRunForTask,
  canTransitionRun,
  classifyCancellation,
  isRunLost,
  isRunFailureCategory,
  taskStarted,
  taskFailed,
  taskCancelled,
  describeRunFailure,
  type NextAttempt,
  workerRunFinished,
  DEFAULT_HEARTBEAT_GRACE_MS,
  type RunFailureCategory,
} from '@acbp/contracts';
import { runInCompanyScope } from '../company/company-context-resolver.js';
// ACBP-P7-002: the lifecycle gate's read. Imported directly — it is not a port and has no injectable answer.
import { readLifecycleDecision } from '../company/lifecycle-guard.js';
import type { AutonomousWorkRefusal } from '@acbp/contracts';
import { checkAuthorization } from '../authz/authz-service.js';
import type { Logger } from '@acbp/observability';

export interface CoordinatorOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  readonly auditWriter?: typeof writeAuditEvent;
  /** TEST SEAM ONLY: override the in-tx activity projector (ACBP-P6-008), same fail-closed contract as audit. */
  readonly activityWriter?: ActivityWriteFn;
  /** Injected so liveness is reproducible in tests and identical across a sweep. Defaults to the real clock. */
  readonly now?: Date;
  readonly heartbeatGraceMs?: number;
}

/** The in-transaction feed projector for this module's events (ACBP-P6-008; fail-closed, like the audit write). */
function project(options: CoordinatorOptions): ActivityWriteFn {
  return options.activityWriter ?? projectCompanyActivity;
}

interface ScopeParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}

export interface RunDTO {
  readonly id: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly state: string;
  readonly failureCategory: string | null;
  readonly stopRequested: boolean;
}

function toRunDTO(row: TaskRunRow): RunDTO {
  return {
    id: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    state: row.state,
    failureCategory: row.failure_category,
    stopRequested: row.stop_requested_at !== null,
  };
}

// ── start ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface StartRunParams extends ScopeParams {
  readonly taskId: string;
  /** 1-based. Claimed exactly once per task — a second claimant is told `attempt_taken`, never given a duplicate. */
  readonly attempt: number;
}

export type StartRunResult =
  | { readonly status: 'ok'; readonly run: RunDTO }
  | { readonly status: 'forbidden' }
  | { readonly status: 'attempt_taken' }
  | { readonly status: 'invalid_attempt' }
  | { readonly status: 'task_not_found' }
  // The task exists but cannot be executing — finished, called off, or never queued. Carries the state so the caller
  // can say WHY rather than retrying forever against a task that will never be startable.
  | { readonly status: 'task_not_startable'; readonly taskState: string }
  /**
   * The COMPANY may not do autonomous work (ACBP-P7-002; CDR-079; launch **Gate 14**).
   *
   * A DISTINCT MEMBER, not a reuse of `task_not_startable`. That would be a false statement — the task is
   * perfectly startable; the company is not — and it would send an operator to look at the task's state machine
   * instead of at the company's lifecycle. Carries the gate's precise reason, which distinguishes the account
   * level from the company level and a deliberate pause from an unreadable row.
   */
  | { readonly status: 'company_not_active'; readonly reason: AutonomousWorkRefusal };

/**
 * Claim an attempt and put it straight into `running`.
 *
 * Claim-then-transition rather than a single insert of `running`, because the two facts are different: the claim is
 * what makes the attempt number exclusive, and the transition is what starts the clock. Both happen in one
 * transaction, so a caller never observes a claimed-but-never-started run.
 */
export async function startRun(client: DatabaseClient, params: StartRunParams, options: CoordinatorOptions = {}): Promise<StartRunResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const now = options.now ?? new Date();
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<StartRunResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      // Both of these would otherwise surface as raw constraint errors — the `attempt >= 1` CHECK and the composite
      // task FK — which reach a caller as an opaque 500 instead of something actionable (review pass 1).
      if (!Number.isInteger(params.attempt) || params.attempt < 1) return { status: 'invalid_attempt' };
      const runs = new TaskRunRepository(scope.db);

      // `findLive`, NOT `findById` (review pass 2). A deleted task keeps its row — `tasks` has no DELETE grant — so a
      // raw lookup finds work the owner discarded and the coordinator would start executing it. RLS-confined too, so a
      // task in another company reads as absent: a foreign task is `task_not_found`, never a run claimed against
      // someone else's work, and never an existence oracle.
      const task = await new TaskRepository(scope.db).findLive(params.taskId);
      if (task === undefined) return { status: 'task_not_found' };
      // And the task must be in a state where execution can legitimately be under way. Without this the coordinator
      // would put a `completed` or `cancelled` task straight into `running` — the AI starting work that is over.
      if (!canStartRunForTask(task.state)) return { status: 'task_not_startable', taskState: task.state };

      // ACBP-P7-002 / CDR-079 / launch **Gate 14**: the company must be permitted to do autonomous work at all.
      //
      // BEFORE `claimAttempt`, deliberately. A refusal after the claim would burn an attempt number the caller
      // can never reuse — the task's attempt budget consumed by a company that was never allowed to run.
      //
      // THIS IS THE POINT THAT MAKES "no NEW autonomous work" TRUE. `task_runs` has exactly one insert path,
      // `TaskRunRepository.claimAttempt`, and this is its only production caller — so a refusal here means no new
      // run exists, and therefore no worker body can be invoked for new work, since every body takes a `runId`.
      // In-flight work already under way is a separate concern (safe-stop, CDR-079 §6) and is NOT handled here.
      const lifecycle = await readLifecycleDecision(scope);
      if (!lifecycle.allowed) {
        options.logger?.info('run.start_refused', { metadata: { accountId: scope.tenant.accountId, companyId: scope.tenant.companyId, taskId: params.taskId, reason: lifecycle.reason } });
        return { status: 'company_not_active', reason: lifecycle.reason };
      }

      const claimed = await runs.claimAttempt({
        accountId: scope.tenant.accountId,
        companyId: scope.tenant.companyId,
        taskId: params.taskId,
        attempt: params.attempt,
      });
      // The unique constraint fired: another coordinator owns this attempt. Reporting it beats retrying with the same
      // number, which would loop, or picking the next one, which would silently skip an attempt.
      if (claimed === undefined) return { status: 'attempt_taken' };

      const started = await runs.transition({ runId: claimed.id, expectedState: 'queued', nextState: 'running', startedAt: now });
      // GENUINELY unreachable: we created this row moments ago in this same transaction, so nothing else can have
      // moved it. Throwing rather than returning `attempt_taken` (review pass 1) — that status would be a false
      // statement about a row that exists in `queued`, and a wrong answer to an impossible question is worse than a
      // loud failure. The throw rolls back the claim, leaving no half-started run.
      if (started === undefined) throw new Error('task run claimed but could not be started — invariant violated');

      const startedEvent = taskStarted({ taskId: params.taskId, runId: claimed.id, attempt: params.attempt });
      const startedAuditId = await audit(scope, startedEvent, auditCtx(options));
      await project(options)(scope, startedEvent, startedAuditId);
      return { status: 'ok', run: toRunDTO(started) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── liveness ────────────────────────────────────────────────────────────────────────────────────────────────

export interface HeartbeatRunParams extends ScopeParams {
  readonly runId: string;
}

export type HeartbeatRunResult =
  | { readonly status: 'ok'; readonly stopRequested: boolean }
  | { readonly status: 'forbidden' }
  // The run is no longer `running` — cancelled, reclaimed, or already finished. The worker must stop, not continue.
  | { readonly status: 'not_running' };

/**
 * Advance liveness, and tell the worker whether a stop has been requested.
 *
 * Returning `stopRequested` here is what makes safe-stop *bounded*: the worker already calls this periodically, so it
 * learns about the request at its next natural checkpoint without anyone needing to interrupt it mid-call.
 */
export async function heartbeatRun(client: DatabaseClient, params: HeartbeatRunParams, options: CoordinatorOptions = {}): Promise<HeartbeatRunResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<HeartbeatRunResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const beat = await new TaskRunRepository(scope.db).heartbeat(params.runId);
      if (beat === undefined) return { status: 'not_running' };
      return { status: 'ok', stopRequested: beat.stop_requested_at !== null };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── terminal outcomes ───────────────────────────────────────────────────────────────────────────────────────

export interface FinishRunParams extends ScopeParams {
  readonly runId: string;
  /** Required when finishing as `failed`; refused otherwise. */
  readonly failureCategory?: RunFailureCategory;
}

export type FinishRunResult =
  | { readonly status: 'ok'; readonly run: RunDTO }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'not_running' }
  | { readonly status: 'invalid' };

/**
 * Finish a run as `succeeded`.
 *
 * A SUCCEEDED RUN IS NOT A COMPLETED TASK. Canon requires `task.completed` to carry `artifact_refs[]` — "no
 * artifactless completion" (TASK-005) — so the task's completion is asserted by the ticket that owns artifacts, once
 * the artifact is persisted. This records only that the attempt finished without failing.
 */
export function succeedRun(client: DatabaseClient, params: FinishRunParams, options: CoordinatorOptions = {}): Promise<FinishRunResult> {
  return finish(client, params, 'succeeded', options);
}

/** Finish a run as `failed` with a CLOSED category (TASK-006: "no blank failures" means a category, not a trace). */
export function failRun(client: DatabaseClient, params: FinishRunParams, options: CoordinatorOptions = {}): Promise<FinishRunResult> {
  return finish(client, params, 'failed', options);
}

async function finish(client: DatabaseClient, params: FinishRunParams, nextState: 'succeeded' | 'failed', options: CoordinatorOptions): Promise<FinishRunResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const now = options.now ?? new Date();
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<FinishRunResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      // A category is REQUIRED on failure and REFUSED on success. Allowing either would produce a row that contradicts
      // its own state, and the DB CHECK would reject it anyway — better a typed refusal than a constraint error.
      if (nextState === 'failed' && !isRunFailureCategory(params.failureCategory)) return { status: 'invalid' };
      if (nextState === 'succeeded' && params.failureCategory !== undefined) return { status: 'invalid' };

      const runs = new TaskRunRepository(scope.db);
      const current = await runs.findById(params.runId);
      if (current === undefined) return { status: 'not_found' };
      if (!canTransitionRun(current.state, nextState)) return { status: 'not_running' };

      const updated = await runs.transition({
        runId: params.runId,
        expectedState: current.state,
        nextState,
        failureCategory: nextState === 'failed' ? (params.failureCategory ?? null) : null,
        endedAt: now,
      });
      if (updated === undefined) return { status: 'not_running' };

      if (nextState === 'failed') {
        // The retry state comes from the SAME function the run read uses (ACBP-P5-013), so the audit trail and
        // what a founder is shown can never disagree about whether another attempt is coming.
        const failedEvent = taskFailed({
          taskId: updated.task_id,
          runId: updated.id,
          attempt: updated.attempt,
          failureCategory: params.failureCategory as RunFailureCategory,
          retryState: retryStateFor(updated.attempt, params.failureCategory),
        });
        const auditEventId = await audit(scope, failedEvent, auditCtx(options));
        // ACT-005: the failure reaches the FOUNDER, not just the audit store. This projection is why the feed
        // can no longer show a company where nothing ever goes wrong.
        await project(options)(scope, failedEvent, auditEventId);
      }
      return { status: 'ok', run: toRunDTO(updated) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── cancellation: the two distinct operations ───────────────────────────────────────────────────────────────

export interface CancelRunParams extends ScopeParams {
  readonly runId: string;
}

export type CancelRunResult =
  // A queued run had not started, so it is cancelled outright.
  | { readonly status: 'cancelled'; readonly run: RunDTO }
  // A running run gets a durable stop request; the worker halts at its next safe point (bounded by the heartbeat).
  | { readonly status: 'stop_requested'; readonly run: RunDTO }
  | { readonly status: 'already_terminal'; readonly state: string }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' };

/**
 * *"Cancel queued instant; running safe-stop bounded"* — the acceptance clause's two halves, kept as two outcomes.
 *
 * They are genuinely different operations. A queued run has no worker to consult, so waiting for one would hang on a
 * process that may never exist. A running run is mid-flight, and killing it outright would abandon work part-way
 * through a tool call — which is exactly what §4's "current tool call completes/aborts safely, then halt" forbids.
 */
export async function cancelRun(client: DatabaseClient, params: CancelRunParams, options: CoordinatorOptions = {}): Promise<CancelRunResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const now = options.now ?? new Date();
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<CancelRunResult> => {
      // Cancellation is the OWNER's decision, not the worker's — hence a separate action from `run:execute`.
      if (checkAuthorization(role, 'run:cancel', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const runs = new TaskRunRepository(scope.db);
      const current = await runs.findById(params.runId);
      if (current === undefined) return { status: 'not_found' };

      const kind = classifyCancellation(current.state);
      if (kind.kind === 'already_terminal') return { status: 'already_terminal', state: current.state };

      if (kind.kind === 'immediate') {
        const cancelled = await runs.transition({ runId: params.runId, expectedState: 'queued', nextState: 'cancelled', endedAt: now });
        if (cancelled !== undefined) {
          await audit(scope, taskCancelled({ taskId: cancelled.task_id, runId: cancelled.id, phase: 'queued' }), auditCtx(options));
          return { status: 'cancelled', run: toRunDTO(cancelled) };
        }
        // The guard missed: the run was picked up between our read and our write. Found in review pass 1 — the
        // previous code reported `already_terminal` here, which is a LIE about a running run, and the worst possible
        // one: an owner is told their cancellation landed while the work carries on. Re-read and answer honestly.
        const afterRace = await runs.findById(params.runId);
        if (afterRace === undefined) return { status: 'not_found' };
        if (classifyCancellation(afterRace.state).kind !== 'safe_stop_requested') {
          return { status: 'already_terminal', state: afterRace.state };
        }
        // It is running now, so the owner's request becomes a safe-stop — which is what they would have got had they
        // asked a moment later, and is what they actually want: the work stopped.
      }

      // Running: record the request durably. The run stays `running` until the worker halts and reports — anything
      // else would claim the work had stopped before it actually had.
      const requested = await runs.requestStop(params.runId);
      if (requested === undefined) {
        const latest = await runs.findById(params.runId);
        return latest === undefined ? { status: 'not_found' } : { status: 'already_terminal', state: latest.state };
      }
      await audit(scope, taskCancelled({ taskId: requested.task_id, runId: requested.id, phase: 'running_safe_stop' }), auditCtx(options));
      return { status: 'stop_requested', run: toRunDTO(requested) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── reclaiming lost runs: "timeout works" ───────────────────────────────────────────────────────────────────

export interface ReclaimLostRunsParams extends ScopeParams {
  readonly limit?: number;
}

export type ReclaimLostRunsResult = { readonly status: 'ok'; readonly reclaimed: readonly string[] } | { readonly status: 'forbidden' };

const MAX_SWEEP = 100;

/**
 * Fail every run whose worker has gone silent past the grace, with category `worker_lost` (FAILURE-AND-RECOVERY row 4).
 *
 * A SWEEP, not a timer. The process that would have held a timer is the one most likely to have died — which is the
 * very failure this detects. Liveness is a timestamp, lostness is a comparison, and any healthy process can run it.
 *
 * `now` is captured ONCE for the whole sweep so every run in a batch is judged against the same instant; judging them
 * against a drifting clock would make the batch's results depend on how long the batch took.
 */
export async function reclaimLostRuns(client: DatabaseClient, params: ReclaimLostRunsParams, options: CoordinatorOptions = {}): Promise<ReclaimLostRunsResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const now = options.now ?? new Date();
  const grace = options.heartbeatGraceMs ?? DEFAULT_HEARTBEAT_GRACE_MS;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ReclaimLostRunsResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const runs = new TaskRunRepository(scope.db);
      const requested = params.limit ?? MAX_SWEEP;
      const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_SWEEP) : MAX_SWEEP;

      const reclaimed: string[] = [];
      for (const row of await runs.listRunning(limit)) {
        if (!isRunLost({ state: row.state, lastHeartbeatAt: row.last_heartbeat_at, startedAt: row.started_at }, now, grace)) continue;
        const failed = await runs.transition({
          runId: row.id,
          expectedState: 'running',
          nextState: 'failed',
          failureCategory: 'worker_lost',
          endedAt: now,
        });
        // The guard did not match: the worker came back and finished, or an owner cancelled, between the read and the
        // write. That is a normal race and the other outcome wins — reclaiming anyway would overwrite a real result.
        if (failed === undefined) continue;
        // A REAPED RUN IS STILL A FAILURE THE FOUNDER OWNS. Projecting here too is what stops the feed from
        // being honest about failures a worker reported and silent about the ones where the worker vanished —
        // the second kind being the one most worth seeing.
        const reapedEvent = taskFailed({
          taskId: failed.task_id,
          runId: failed.id,
          attempt: failed.attempt,
          failureCategory: 'worker_lost',
          retryState: retryStateFor(failed.attempt, 'worker_lost'),
        });
        const reapedAuditId = await audit(scope, reapedEvent, auditCtx(options));
        await project(options)(scope, reapedEvent, reapedAuditId);

        // REAP THE WORKER RUN TOO (ACBP-P5-005, review pass 2). A reclaimed attempt's worker run would otherwise sit
        // at `running` for ever: no `worker.failed` record of how it ended, and a permanent entry in the safe-stop
        // sweep's "live runs" — so a later disable would keep finding a run that died long ago.
        const workerRuns = new WorkerRunRepository(scope.db);
        const orphan = await workerRuns.findByTaskRun(failed.id);
        if (orphan !== undefined && orphan.outcome === 'running') {
          const closed = await workerRuns.finish({ workerRunId: orphan.id, outcome: 'failed', failureCategory: 'worker_lost' });
          if (closed !== undefined) {
            await audit(
              scope,
              workerRunFinished({ workerRunId: closed.id, workerId: closed.worker_id, workerVersion: closed.worker_version, outcome: 'failed', failureCategory: 'worker_lost' }),
              auditCtx(options),
            );
          }
        }
        reclaimed.push(failed.id);
      }
      if (reclaimed.length > 0) options.logger?.warn('run.reclaimed_lost', { metadata: { companyId: params.companyId, count: reclaimed.length } });
      return { status: 'ok', reclaimed };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

/**
 * The retry state a failure carries into the audit trail (ACBP-P5-013; TASK-010).
 *
 * Derived from describeRunFailure rather than computed here, so the value written to the audit event is the SAME
 * value the run read shows a founder. Two independent derivations of 'is another attempt coming' would eventually
 * disagree, and the trail is the thing people reach for when they already suspect the screen.
 */
function retryStateFor(attempt: number, failureCategory: unknown): NextAttempt {
  return describeRunFailure({ state: 'failed', failureCategory, attempt })?.nextAttempt ?? 'not_eligible';
}

function auditCtx(options: CoordinatorOptions): AuditWriteContext {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}
function opts(options: CoordinatorOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}
