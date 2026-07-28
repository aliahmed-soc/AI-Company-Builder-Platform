// @acbp/core — the worker runtime (ACBP-P5-005; CDR-057; WORK-001..006; NFR-015; ADR-012; trust-critical #3).
//
// ONE SHARED EXECUTOR. Canon is explicit that workers are "versioned configuration + prompts over one shared execution
// runtime — not independent agent services", so this module runs every worker and none of them ships its own loop.
//
// IT NEVER EXECUTES A TOOL ITSELF. Every tool call goes through `dispatchToolCall`; the chokepoint is only a chokepoint
// if the component doing the work cannot go around it (invariant 4).
//
// THE STEP IS A SEAM, not a placeholder for its own sake. No worker logic exists yet (P5-006/007/008) and no live
// provider has ever been called, so the caller supplies the step. That seam is what makes the budget and duration
// halts provable TODAY against a real database — a halt asserted through a fake provider would prove the fake.
import { WorkerRunRepository, WorkerRepository, TaskRunRepository, writeAuditEvent, type DatabaseClient, type AuditWriteContext, type WorkerRunRow } from '@acbp/database';
import { decideStepAdmission, workerAcceptsTasks, isWorkerState, isMvpSafeAllowlist, workerRunStarted, workerRunFinished, type HaltReason } from '@acbp/contracts';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import type { Logger } from '@acbp/observability';

export interface RuntimeOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  readonly auditWriter?: typeof writeAuditEvent;
  /** Injected so elapsed time is reproducible in tests and identical across one admission decision. */
  readonly now?: Date;
}

interface ScopeParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}

export interface WorkerRunDTO {
  readonly id: string;
  readonly taskRunId: string;
  readonly workerId: string;
  readonly workerVersion: number;
  readonly maxSpendMicros: number;
  readonly maxDurationMs: number;
  readonly spendMicros: number;
  readonly stepsCompleted: number;
  readonly outcome: string;
  readonly failureCategory: string | null;
  readonly haltReason: string | null;
}

function toDTO(row: WorkerRunRow): WorkerRunDTO {
  return {
    id: row.id,
    taskRunId: row.task_run_id,
    workerId: row.worker_id,
    workerVersion: row.worker_version,
    maxSpendMicros: row.max_spend_micros,
    maxDurationMs: row.max_duration_ms,
    spendMicros: row.spend_micros,
    stepsCompleted: row.steps_completed,
    outcome: row.outcome,
    failureCategory: row.failure_category,
    haltReason: row.halt_reason,
  };
}

// ── starting a worker run ───────────────────────────────────────────────────────────────────────────────────

export interface StartWorkerRunParams extends ScopeParams {
  readonly taskRunId: string;
  readonly workerId: string;
}

export type StartWorkerRunResult =
  | { readonly status: 'ok'; readonly workerRun: WorkerRunDTO }
  | { readonly status: 'forbidden' }
  | { readonly status: 'unknown_worker' }
  // WORK-006: the owner has paused or disabled this worker for this company. It receives no new work.
  | { readonly status: 'not_accepting'; readonly state: string }
  // The definition's allowlist reaches past the MVP ceiling (CDR-056 §6-G8). It may exist; it may not run.
  | { readonly status: 'mvp_boundary_violation'; readonly offendingTools: readonly string[] }
  | { readonly status: 'run_not_running'; readonly runState: string }
  | { readonly status: 'run_not_found' }
  // `UNIQUE(task_run_id)` fired: this attempt already has a worker. One worker executes one attempt.
  | { readonly status: 'already_stamped'; readonly workerRun: WorkerRunDTO };

/**
 * Stamp a worker onto a task run and begin executing.
 *
 * THE BOUNDS ARE SNAPSHOT, not referenced (CDR-057 §1-G2). Re-reading the definition on each step would let an edit
 * mid-flight change the budget a run is being judged against, and the record would stop saying what was enforced.
 */
export async function startWorkerRun(client: DatabaseClient, params: StartWorkerRunParams, options: RuntimeOptions = {}): Promise<StartWorkerRunResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<StartWorkerRunResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };

      // The task run must exist, belong to this company (RLS-confined, so a foreign one reads as absent) and be
      // RUNNING — a worker cannot begin executing an attempt that is over.
      const taskRun = await new TaskRunRepository(scope.db).findById(params.taskRunId);
      if (taskRun === undefined) return { status: 'run_not_found' };
      if (taskRun.state !== 'running') return { status: 'run_not_running', runState: taskRun.state };

      const workers = new WorkerRepository(scope.db);
      const definition = await workers.findActiveDefinition(params.workerId);
      if (definition === undefined) return { status: 'unknown_worker' };

      const stored = await workers.findCompanyState(params.workerId);
      const state = stored?.state ?? 'enabled';
      if (!workerAcceptsTasks(state)) return { status: 'not_accepting', state: isWorkerState(state) ? state : 'disabled' };

      // The MVP boundary is re-checked HERE and not merely at resolution, because this is the moment work actually
      // begins. Checking only in the read path would leave the enforcement one caller away from being skipped.
      const classes = await workers.toolRiskClasses(definition.allowed_tools);
      const byId = new Map(classes.map((c) => [c.tool_id, c.risk_class]));
      const entries = definition.allowed_tools.map((toolId) => ({ toolId, riskClass: byId.get(toolId) }));
      const offendingTools = entries.filter((e) => !isMvpSafeAllowlist([e])).map((e) => e.toolId);
      if (offendingTools.length > 0) return { status: 'mvp_boundary_violation', offendingTools };

      const runs = new WorkerRunRepository(scope.db);
      const started = await runs.start({
        accountId: scope.tenant.accountId,
        companyId: scope.tenant.companyId,
        taskRunId: params.taskRunId,
        workerId: params.workerId,
        workerVersion: definition.version,
        maxSpendMicros: definition.max_spend_micros,
        maxDurationMs: definition.max_duration_ms,
      });
      if (started === undefined) {
        const existing = await runs.findByTaskRun(params.taskRunId);
        if (existing === undefined) throw new Error('worker run insert wrote nothing and no existing stamp exists — invariant violated');
        return { status: 'already_stamped', workerRun: toDTO(existing) };
      }

      await audit(scope, workerRunStarted({ workerRunId: started.id, workerId: started.worker_id, workerVersion: started.worker_version }), auditCtx(options));
      return { status: 'ok', workerRun: toDTO(started) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── executing one step ──────────────────────────────────────────────────────────────────────────────────────

/** What a step reports back. `spentMicros` is what it actually cost — the counter the budget is enforced against. */
export interface StepResult {
  readonly spentMicros: number;
}

export interface RunWorkerStepParams extends ScopeParams {
  readonly workerRunId: string;
  /** The work. Supplied by the caller until P5-006/007/008 provide real worker logic (CDR-057 §3). */
  readonly step: () => Promise<StepResult>;
}

export type RunWorkerStepResult =
  | { readonly status: 'ok'; readonly workerRun: WorkerRunDTO }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'not_running'; readonly outcome: string }
  // The step was NOT executed. Whatever the reason, nothing was spent on it.
  | { readonly status: 'halted'; readonly reason: HaltReason; readonly workerRun: WorkerRunDTO }
  // The owner's safe-stop landed. Also not executed — and NOT a failure (CDR-057 §1-G7).
  | { readonly status: 'stopped'; readonly workerRun: WorkerRunDTO };

/**
 * Execute one step, bracketed by the budget and duration checks.
 *
 * THE CHECK COMES FIRST, and that ordering is NFR-015's *"no more than one billing increment"*. The step runs only
 * while headroom remains, so the most a run can exceed its cap by is the single call that crossed the line. Checking
 * afterwards would bound nothing — one expensive call could land arbitrarily far past the cap.
 *
 * A HALT ENDS THE RUN. There is no "skip this step and try the next": the bound is on the run, so the run is over.
 */
export async function runWorkerStep(client: DatabaseClient, params: RunWorkerStepParams, options: RuntimeOptions = {}): Promise<RunWorkerStepResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const now = options.now ?? new Date();
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<RunWorkerStepResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const runs = new WorkerRunRepository(scope.db);
      const current = await runs.findById(params.workerRunId);
      if (current === undefined) return { status: 'not_found' };
      if (current.outcome !== 'running') return { status: 'not_running', outcome: current.outcome };

      // The safe-stop request lives on the TASK run (P5-002 owns cancellation), so this is where the worker learns of
      // it — at a checkpoint, between steps, exactly as §4 requires rather than mid-call.
      const taskRun = await new TaskRunRepository(scope.db).findById(current.task_run_id);
      const admission = decideStepAdmission({
        maxSpendMicros: current.max_spend_micros,
        maxDurationMs: current.max_duration_ms,
        spentMicros: current.spend_micros,
        elapsedMs: now.getTime() - current.started_at.getTime(),
        stopRequested: taskRun?.stop_requested_at != null,
      });

      if (admission.kind === 'stop') {
        const stopped = await runs.finish({ workerRunId: params.workerRunId, outcome: 'stopped' });
        if (stopped === undefined) return { status: 'not_running', outcome: (await runs.findById(params.workerRunId))?.outcome ?? 'running' };
        await audit(scope, workerRunFinished({ workerRunId: stopped.id, workerId: stopped.worker_id, workerVersion: stopped.worker_version, outcome: 'stopped' }), auditCtx(options));
        return { status: 'stopped', workerRun: toDTO(stopped) };
      }

      if (admission.kind === 'halt') {
        const halted = await runs.finish({ workerRunId: params.workerRunId, outcome: 'failed', failureCategory: admission.failureCategory, haltReason: admission.reason });
        if (halted === undefined) return { status: 'not_running', outcome: (await runs.findById(params.workerRunId))?.outcome ?? 'running' };
        // WARN, because NFR-015's failure clause is "Cap breaches halt the task AND ALERT". Scalars only.
        options.logger?.warn('worker.run_halted', { metadata: { companyId: params.companyId, workerId: halted.worker_id, reason: admission.reason, spendMicros: halted.spend_micros } });
        await audit(scope, workerRunFinished({ workerRunId: halted.id, workerId: halted.worker_id, workerVersion: halted.worker_version, outcome: 'failed', failureCategory: admission.failureCategory, haltReason: admission.reason }), auditCtx(options));
        return { status: 'halted', reason: admission.reason, workerRun: toDTO(halted) };
      }

      const result = await params.step();
      // A step that reports nonsense is recorded as costing NOTHING rather than as a negative or NaN spend, which
      // would corrupt the counter the budget is enforced against. The step still counts as taken.
      const spent = Number.isFinite(result?.spentMicros) && result.spentMicros > 0 ? Math.floor(result.spentMicros) : 0;
      const updated = await runs.recordStep(params.workerRunId, spent);
      if (updated === undefined) return { status: 'not_running', outcome: (await runs.findById(params.workerRunId))?.outcome ?? 'running' };
      return { status: 'ok', workerRun: toDTO(updated) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── finishing ───────────────────────────────────────────────────────────────────────────────────────────────

export interface FinishWorkerRunParams extends ScopeParams {
  readonly workerRunId: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly failureCategory?: string;
}

export type FinishWorkerRunResult =
  | { readonly status: 'ok'; readonly workerRun: WorkerRunDTO }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'not_running'; readonly outcome: string }
  | { readonly status: 'invalid' };

/** Close a worker run. GUARDED on `running`, so a run that already halted cannot be talked back into succeeding. */
export async function finishWorkerRun(client: DatabaseClient, params: FinishWorkerRunParams, options: RuntimeOptions = {}): Promise<FinishWorkerRunResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<FinishWorkerRunResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      if (params.outcome !== 'succeeded' && params.outcome !== 'failed') return { status: 'invalid' };
      // A category is REQUIRED on failure and REFUSED on success — the P5-002 shape, for the same reason: a row that
      // contradicts its own outcome is worse than a typed refusal.
      if (params.outcome === 'failed' && (params.failureCategory ?? '') === '') return { status: 'invalid' };
      if (params.outcome === 'succeeded' && params.failureCategory !== undefined) return { status: 'invalid' };

      const runs = new WorkerRunRepository(scope.db);
      const current = await runs.findById(params.workerRunId);
      if (current === undefined) return { status: 'not_found' };
      if (current.outcome !== 'running') return { status: 'not_running', outcome: current.outcome };

      const finished = await runs.finish({
        workerRunId: params.workerRunId,
        outcome: params.outcome,
        failureCategory: params.outcome === 'failed' ? (params.failureCategory ?? null) : null,
      });
      if (finished === undefined) return { status: 'not_running', outcome: (await runs.findById(params.workerRunId))?.outcome ?? 'running' };

      await audit(
        scope,
        workerRunFinished({
          workerRunId: finished.id,
          workerId: finished.worker_id,
          workerVersion: finished.worker_version,
          outcome: params.outcome,
          ...(params.outcome === 'failed' ? { failureCategory: params.failureCategory as string } : {}),
        }),
        auditCtx(options),
      );
      return { status: 'ok', workerRun: toDTO(finished) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

function auditCtx(options: RuntimeOptions): AuditWriteContext {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}
function opts(options: RuntimeOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}
