// @acbp/core — the worker runtime (ACBP-P5-005; CDR-057; WORK-001..006; NFR-015; ADR-012; trust-critical #3).
//
// ONE SHARED EXECUTOR. Canon is explicit that workers are "versioned configuration + prompts over one shared execution
// runtime — not independent agent services", so this module runs every worker and none of them ships its own loop.
//
// IT HAS NO TOOL-INVOCATION PATH AT ALL. Be precise about this, because the imprecise version was a review finding:
// this module does not call `dispatchToolCall`, and nothing here structurally prevents a step closure from calling a
// tool directly. What is true today is the narrower statement — the runtime never reaches a tool, because it has no
// way to. Routing every worker tool call through the chokepoint (invariant 4) is a FORWARD OBLIGATION on the tickets
// that give workers actual logic (P5-006/007/008), not a guarantee this ticket delivers.
//
// THE STEP IS A SEAM, not a placeholder for its own sake. No worker logic exists yet and no live provider has ever
// been called, so the caller supplies the step. That seam is what makes the budget and duration halts provable TODAY
// against a real database — a halt asserted through a fake provider would prove the fake.
import { WorkerRunRepository, WorkerRepository, TaskRunRepository, writeAuditEvent, type DatabaseClient, type AuditWriteContext, type WorkerRunRow } from '@acbp/database';
import {
  decideStepAdmission,
  workerAcceptsTasks,
  isWorkerState,
  isMvpSafeAllowlist,
  isWorkerRunOutcome,
  isTerminalWorkerRunOutcome,
  isRunFailureCategory,
  workerRunStarted,
  workerRunFinished,
  type HaltReason,
  type WorkerRunOutcome,
} from '@acbp/contracts';
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
  /** The CLOSED set, not `string`. A stored value outside it never leaves this module as if it were an outcome. */
  readonly outcome: WorkerRunOutcome;
  readonly failureCategory: string | null;
  readonly haltReason: string | null;
}

function toDTO(row: WorkerRunRow): WorkerRunDTO {
  // Validate on the way OUT of the database, not just on the way in. The CHECK constraint makes an invalid outcome
  // impossible today, but a DTO typed `string` would let a future widening leak straight through — and having written
  // a closed-set guard, leaving it uncalled is the defect that was the finding on P5-004.
  if (!isWorkerRunOutcome(row.outcome)) throw new Error('worker run carries an outcome outside the closed set — invariant violated');
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
  | { readonly status: 'already_stamped'; readonly workerRun: WorkerRunDTO }
  // ...and it is a DIFFERENT worker's. Named separately so "you already have one" cannot be read off another's run.
  | { readonly status: 'stamped_by_other_worker'; readonly workerId: string };

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
      // A run whose owner has already asked it to stop is not work to hand out. Stamping one would emit a `started`
      // and an immediate `stopped` with zero steps — a trace that says a worker ran when none did.
      if (taskRun.stop_requested_at !== null) return { status: 'run_not_running', runState: taskRun.state };

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
        // WHOSE stamp matters. `already_stamped` reads as "you already have one"; returning it for a run another
        // worker owns would hand the caller a different worker's run under that reassuring word.
        if (existing.worker_id !== params.workerId) return { status: 'stamped_by_other_worker', workerId: existing.worker_id };
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
  | { readonly status: 'not_running'; readonly outcome: WorkerRunOutcome }
  // The step was NOT executed. Whatever the reason, nothing was spent on it.
  | { readonly status: 'halted'; readonly reason: HaltReason; readonly workerRun: WorkerRunDTO }
  // The owner's safe-stop landed, or the attempt itself is over. Also not executed — and NOT a failure (§1-G7).
  | { readonly status: 'stopped'; readonly workerRun: WorkerRunDTO }
  // The step itself threw. Typed, because a raw internal error at the boundary tells a caller nothing it can act on.
  | { readonly status: 'step_failed'; readonly workerRun: WorkerRunDTO };

/** A spend the counter can hold. `integer` overflows at ~2.1e9 and would roll the transaction back instead of halting. */
const MAX_STEP_SPEND_MICROS = 1_000_000_000;

/**
 * Execute one step, bracketed by the budget and duration checks.
 *
 * THE CHECK COMES FIRST, and that ordering is NFR-015's *"no more than one billing increment"*. The step runs only
 * while headroom remains, so the most a run can exceed its cap by is the single call that crossed the line. Checking
 * afterwards would bound nothing — one expensive call could land arbitrarily far past the cap.
 *
 * A HALT ENDS THE RUN. There is no "skip this step and try the next": the bound is on the run, so the run is over.
 *
 * THE ROW IS LOCKED FOR THE DECISION (review pass 1). Two concurrent callers on one run would otherwise both read the
 * same spend, both find headroom, and both execute — turning "no more than one increment" into N. The in-SQL
 * increment prevents a lost UPDATE; it does nothing about double ADMISSION, which is the part the bound depends on.
 */
export async function runWorkerStep(client: DatabaseClient, params: RunWorkerStepParams, options: RuntimeOptions = {}): Promise<RunWorkerStepResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<RunWorkerStepResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const runs = new WorkerRunRepository(scope.db);
      const current = await runs.findByIdForUpdate(params.workerRunId);
      if (current === undefined) return { status: 'not_found' };
      if (isTerminalWorkerRunOutcome(current.outcome)) return notRunning(current.outcome);

      // ── EVERYTHING THAT SAYS "STOP" ───────────────────────────────────────────────────────────────────────
      //
      // THE ATTEMPT MUST STILL BE LIVE. Review pass 1's HIGH finding: the first version read the task run and looked
      // only at `stop_requested_at`, ignoring its STATE. A task run reclaimed as `worker_lost` or failed by its owner
      // is no longer `running`, so `requestStop` — which is guarded on `running` — can never mark it again. The
      // worker run would have become permanently unstoppable: the safe-stop sweep would report reaching nothing
      // while the worker kept spending, possibly alongside a retry attempt. Every test passed because the fixtures
      // only ever produced live task runs — the same way the fixtures agreed with the bug in P5-002.
      //
      // FAIL CLOSED on an absent task run: `undefined` means gone or invisible, and neither is a reason to keep going.
      const taskRun = await new TaskRunRepository(scope.db).findById(current.task_run_id);
      const attemptOver = taskRun === undefined || taskRun.state !== 'running';

      // AND THE WORKER MUST STILL BE ACCEPTING WORK. `startWorkerRun` checks this, but a disable committing
      // concurrently with a start sees no uncommitted row to sweep, so that run would begin with no stop request
      // against it. Re-reading here — the designated checkpoint — closes the write skew rather than locking two
      // tables on every path.
      const state = (await new WorkerRepository(scope.db).findCompanyState(current.worker_id))?.state ?? 'enabled';

      const admission = decideStepAdmission({
        maxSpendMicros: current.max_spend_micros,
        maxDurationMs: current.max_duration_ms,
        spentMicros: current.spend_micros,
        // From the DATABASE's clock, not Node's — see `findByIdForUpdate`. Mixing the two makes elapsed time wrong,
        // and negative skew would read as an unreadable bound and halt a healthy run.
        elapsedMs: current.elapsed_ms,
        stopRequested: attemptOver || !workerAcceptsTasks(state) || taskRun?.stop_requested_at != null,
      });

      if (admission.kind === 'stop') return finishAs(scope, runs, params.workerRunId, { outcome: 'stopped' }, 'stopped', audit, options);

      if (admission.kind === 'halt') {
        const halted = await finishAs(scope, runs, params.workerRunId, { outcome: 'failed', failureCategory: admission.failureCategory, haltReason: admission.reason }, 'halted', audit, options, admission.reason);
        if (halted.status === 'halted') {
          // NFR-015 says cap breaches halt THE TASK and alert — not merely the worker run. A durable stop request is
          // how canon halts a running run (`WORKFLOW-STATE-MACHINES §4`), so the task stops too rather than sitting
          // `running` with no worker until the reaper mislabels it `worker_lost` and destroys the honest category.
          // The TERMINAL transition stays the coordinator's (P5-002's `failRun`); this ticket does not take it over.
          if (taskRun !== undefined && taskRun.state === 'running') await new TaskRunRepository(scope.db).requestStop(taskRun.id);
          options.logger?.warn('worker.run_halted', { metadata: { companyId: params.companyId, workerId: halted.workerRun.workerId, reason: admission.reason, spendMicros: halted.workerRun.spendMicros } });
        }
        return halted;
      }

      // ── THE STEP ──────────────────────────────────────────────────────────────────────────────────────────
      let result: StepResult;
      try {
        result = await params.step();
      } catch {
        // A THROW IS NOT A ROLLBACK. Letting it propagate would undo the whole transaction, so a step that spent real
        // provider money and then failed would leave the counter untouched — and a caller retrying in a loop could
        // spend indefinitely without ever advancing toward the cap. The exception text is never surfaced or stored.
        // ACBP-P7-008 MUTATION PROBE - DO NOT MERGE: the throw propagates, so the whole transaction rolls
        // back and no failed row survives.
        throw new Error('probe: step failure propagates instead of being recorded');
      }

      // A step reporting nonsense costs NOTHING rather than a negative, NaN or overflowing spend — any of which would
      // corrupt the very counter the budget is enforced against. The step still counts as taken.
      const reported = result?.spentMicros;
      const spent = Number.isFinite(reported) && reported > 0 ? Math.min(Math.floor(reported), MAX_STEP_SPEND_MICROS) : 0;
      const updated = await runs.recordStep(params.workerRunId, spent);
      if (updated === undefined) return notRunning((await runs.findById(params.workerRunId))?.outcome);
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
      // contradicts its own outcome is worse than a typed refusal. The VALUE is checked against the closed set, not
      // merely its presence (review pass 1): an out-of-set category would otherwise sail past this guard, hit the DB
      // CHECK, and surface as an unclassified internal error where a typed refusal was promised.
      if (params.outcome === 'failed' && !isRunFailureCategory(params.failureCategory)) return { status: 'invalid' };
      if (params.outcome === 'succeeded' && params.failureCategory !== undefined) return { status: 'invalid' };

      const runs = new WorkerRunRepository(scope.db);
      const current = await runs.findById(params.workerRunId);
      if (current === undefined) return { status: 'not_found' };
      if (isTerminalWorkerRunOutcome(current.outcome)) return notRunning(current.outcome);

      const finished = await runs.finish({
        workerRunId: params.workerRunId,
        outcome: params.outcome,
        failureCategory: params.outcome === 'failed' ? (params.failureCategory ?? null) : null,
      });
      if (finished === undefined) return notRunning((await runs.findById(params.workerRunId))?.outcome);

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

/** A run that is no longer ours to step. Reported with the CLOSED outcome, never a bare string. */
function notRunning(outcome: unknown): { readonly status: 'not_running'; readonly outcome: WorkerRunOutcome } {
  return { status: 'not_running', outcome: isWorkerRunOutcome(outcome) ? outcome : 'running' };
}

/**
 * Close a run and audit it, in one place.
 *
 * ONE PATH for every ending, so no ending can be added later that forgets its audit record — the P5-003b lesson,
 * where exactly one refusal path lost its auditing and nothing noticed.
 */
async function finishAs(
  scope: Parameters<typeof writeAuditEvent>[0],
  runs: WorkerRunRepository,
  workerRunId: string,
  close: { outcome: 'stopped' | 'failed'; failureCategory?: string; haltReason?: HaltReason },
  status: 'stopped' | 'halted' | 'step_failed',
  audit: typeof writeAuditEvent,
  options: RuntimeOptions,
  reason?: HaltReason,
): Promise<RunWorkerStepResult> {
  const closed = await runs.finish({
    workerRunId,
    outcome: close.outcome,
    failureCategory: close.failureCategory ?? null,
    haltReason: close.haltReason ?? null,
  });
  // The guard did not match: something else ended the run between our read and our write. The other outcome wins.
  if (closed === undefined) return notRunning((await runs.findById(workerRunId))?.outcome);
  await audit(
    scope,
    workerRunFinished({
      workerRunId: closed.id,
      workerId: closed.worker_id,
      workerVersion: closed.worker_version,
      outcome: close.outcome,
      ...(close.failureCategory !== undefined ? { failureCategory: close.failureCategory } : {}),
      ...(close.haltReason !== undefined ? { haltReason: close.haltReason } : {}),
    }),
    auditCtx(options),
  );
  const dto = toDTO(closed);
  if (status === 'halted') return { status: 'halted', reason: reason ?? 'bounds_unreadable', workerRun: dto };
  return status === 'stopped' ? { status: 'stopped', workerRun: dto } : { status: 'step_failed', workerRun: dto };
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
