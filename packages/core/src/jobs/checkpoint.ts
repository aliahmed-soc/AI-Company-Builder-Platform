// @acbp/core — checkpoints and resume (ACBP-P5-001b; CDR-050; ADR-008; NFR-005).
//
// Two use cases:
//   - runJobStep   — execute a step ONCE, recording the checkpoint in the SAME transaction as its effect;
//   - getResumeState — what still has to run, computed as the plan minus the checkpoint inventory.
//
// THE FAILURE THIS EXCLUDES IS DOUBLE EXECUTION, not a wasteful restart. A step whose effect already landed running a
// second time after a crash spends budget twice and, once external tools exist (P5-003), repeats an external effect.
// That is why the checkpoint and the effect share one transaction (CDR-050 §3-G5): a checkpoint written afterwards
// leaves a window in which the effect landed and the record did not — the exact state a resume must interpret, and
// the one it cannot interpret correctly.
import { JobRepository, type DatabaseClient, type JobCheckpointRow } from '@acbp/database';
import { remainingSteps, planProgress, InvalidPlanError, type PlanProgress, type PlanFailure, type AutonomousWorkRefusal } from '@acbp/contracts';
import { runInCompanyScope } from '../company/company-context-resolver.js';
// ACBP-P7-002: the lifecycle gate's read. Imported directly — not a port, no injectable answer.
import { readLifecycleDecision } from '../company/lifecycle-guard.js';
import { checkAuthorization } from '../authz/authz-service.js';
import type { Logger } from '@acbp/observability';
import type { Transaction } from 'kysely';
import type { DatabaseSchema } from '@acbp/database';

export interface CheckpointOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
}

/**
 * What a step's body receives. Deliberately given the SAME transaction the checkpoint is written in, so a step that
 * writes to the database is atomic with the record that it ran. A step that throws rolls both back, and the step has
 * then genuinely not run — which is what makes re-running it correct rather than a double execution.
 */
export interface JobStepContext {
  readonly db: Transaction<DatabaseSchema>;
  readonly jobId: string;
  readonly stepName: string;
  /** Outputs of previously completed steps, keyed by step name. Only steps that recorded one appear. */
  readonly previousOutputs: Readonly<Record<string, Record<string, unknown>>>;
}

/** A step returns what a later step needs, or nothing. References, NEVER secrets (ADR-008 §11). */
export type JobStep = (ctx: JobStepContext) => Promise<Record<string, unknown> | void>;

export interface RunJobStepParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly jobId: string;
  readonly stepName: string;
  readonly step: JobStep;
}

export type RunJobStepResult =
  | { readonly status: 'ok'; readonly output: Record<string, unknown> | null }
  // ALREADY DONE — the step has a checkpoint, so its effect landed and it was NOT run again. This is a success from
  // the caller's point of view and the single most important outcome in this file: it is what "kill-and-resume green"
  // actually means.
  | { readonly status: 'already_completed'; readonly output: Record<string, unknown> | null }
  | { readonly status: 'forbidden' }
  | { readonly status: 'job_not_found' }
  /**
   * The COMPANY may not do autonomous work (ACBP-P7-002; CDR-079; launch **Gate 14**).
   *
   * NOT `already_completed`, which would be a lie about the database, and NOT `forbidden`, which is an answer
   * about the ACTOR. The step did not run and no checkpoint exists, so a later resume — once the company is
   * active again — finds exactly the state it left and continues from here.
   */
  | { readonly status: 'company_not_active'; readonly reason: AutonomousWorkRefusal };

/**
 * Run one step of a job exactly once.
 *
 * The pre-check and the write are BOTH needed and neither is redundant. The pre-check avoids paying for work already
 * done — the common case after a crash. The `ON CONFLICT DO NOTHING` write is what makes it CORRECT: between the
 * pre-check and the insert another worker may complete the same step, and only the database can settle that. If the
 * insert finds the row already there, this transaction aborts, so the step's DATABASE effects are discarded and the
 * winner's are the only ones that survive (see the note at the throw for what an abort does NOT undo).
 */
export async function runJobStep(client: DatabaseClient, params: RunJobStepParams, options: CheckpointOptions = {}): Promise<RunJobStepResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<RunJobStepResult> => {
      if (checkAuthorization(role, 'job:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };

      const jobs = new JobRepository(scope.db);
      // RLS-confined: another company's job is `job_not_found`, never a step run against a foreign job.
      const job = await jobs.findById(params.jobId);
      if (job === undefined) return { status: 'job_not_found' };

      const existing = await jobs.listCheckpoints(params.jobId);
      const done = existing.find((c) => c.step_name === params.stepName);
      if (done !== undefined) {
        // Not an error, and emphatically not a re-run. The step's effect is already in the database.
        options.logger?.info('job.step_already_completed', { metadata: { companyId: params.companyId, stepName: params.stepName } });
        return { status: 'already_completed', output: done.output };
      }

      // ACBP-P7-002 / CDR-079 / launch **Gate 14**: the company must still be permitted to do autonomous work.
      //
      // AFTER the already-completed short-circuit above, and that ordering is load-bearing. Reporting a step that
      // ALREADY RAN as refused would corrupt resume arithmetic — a resumed job would re-run effects the database
      // already holds, or conclude it can never finish. A completed step is a fact, not a request.
      //
      // BEFORE `params.step(...)`, because that closure is the work. A job that began while the company was
      // active must not keep advancing through new steps after a pause: the step boundary is exactly where canon
      // puts the safe stop ("complete current tool call, then halt"), and this is the step boundary.
      const lifecycle = await readLifecycleDecision(scope);
      if (!lifecycle.allowed) {
        options.logger?.info('job.step_refused_lifecycle', { metadata: { accountId: scope.tenant.accountId, companyId: scope.tenant.companyId, jobId: params.jobId, stepName: params.stepName, reason: lifecycle.reason } });
        return { status: 'company_not_active', reason: lifecycle.reason };
      }

      const output = await params.step({
        db: scope.db,
        jobId: params.jobId,
        stepName: params.stepName,
        previousOutputs: toOutputMap(existing),
      });
      const normalized = output === undefined || output === null ? null : output;

      const checkpoint = await jobs.insertCheckpoint({
        accountId: scope.tenant.accountId,
        companyId: scope.tenant.companyId,
        jobId: params.jobId,
        stepName: params.stepName,
        output: normalized,
      });
      if (checkpoint === undefined) {
        // Someone else checkpointed this step between our read and our write. Throwing aborts this transaction, which
        // is the point: our step's DATABASE effects are discarded, leaving one surviving execution — theirs.
        // Returning `ok` would commit a second set of effects for a step the store says ran once.
        //
        // BE PRECISE ABOUT WHAT THIS UNDOES. A transaction abort reverses transactional work and nothing else. A step
        // that made an HTTP call, spent model budget, or touched anything outside this database has ALREADY done so,
        // and no rollback recovers that. Today every step is transactional, so the guarantee is complete; it stops
        // being complete the moment a step can act externally, which is exactly why external effects are routed
        // through the P5-003 dispatcher with an idempotency key (NFR-006) rather than left to this rollback.
        throw new DuplicateStepExecutionError(params.stepName);
      }
      return { status: 'ok', output: checkpoint.output };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

/**
 * Thrown when a concurrent worker checkpointed the same step first. Its purpose is to ABORT the transaction, so the
 * losing worker's effect never commits. A caller that sees this should re-read the plan rather than retry blindly:
 * the step is done.
 */
export class DuplicateStepExecutionError extends Error {
  readonly stepName: string;
  constructor(stepName: string) {
    super(`job step already completed concurrently: ${stepName}`);
    this.name = 'DuplicateStepExecutionError';
    this.stepName = stepName;
  }
}

// ── resume ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface GetResumeStateParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly jobId: string;
  /** The ordered plan. Supplied by the caller, not stored — see CDR-050 §2-G3 on why there is no cursor. */
  readonly plan: readonly string[];
}

export type GetResumeStateResult =
  | {
      readonly status: 'ok';
      readonly completedSteps: readonly string[];
      readonly remainingSteps: readonly string[];
      readonly progress: PlanProgress;
      readonly outputs: Readonly<Record<string, Record<string, unknown>>>;
    }
  | { readonly status: 'forbidden' }
  | { readonly status: 'job_not_found' }
  // The PLAN itself cannot be checkpointed — a duplicate or blank step name. Found in review pass 2: `remainingSteps`
  // throws on this (correctly, since an uncheckpointable plan is a call-site bug), but a READ that throws on
  // caller-supplied input while every sibling read returns a typed status is an inconsistency, and it would surface
  // as an opaque 500 rather than something a caller can act on.
  | { readonly status: 'invalid_plan'; readonly reason: PlanFailure };

/**
 * What still has to run. Pure arithmetic over the plan and the stored inventory (`remainingSteps`), so the resume rule
 * is testable exhaustively without a database and cannot drift between the two call sites.
 */
export async function getResumeState(client: DatabaseClient, params: GetResumeStateParams, options: CheckpointOptions = {}): Promise<GetResumeStateResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<GetResumeStateResult> => {
      if (checkAuthorization(role, 'job:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const jobs = new JobRepository(scope.db);
      const job = await jobs.findById(params.jobId);
      if (job === undefined) return { status: 'job_not_found' };

      const checkpoints = await jobs.listCheckpoints(params.jobId);
      const completed = checkpoints.map((c) => c.step_name);
      // The plan is validated ONCE here and the result reused, rather than letting each of the three calls below
      // throw independently — they would all throw for the same reason, and catching at three sites invites one of
      // them being missed later.
      let remaining: string[];
      try {
        remaining = remainingSteps(params.plan, completed);
      } catch (error) {
        if (error instanceof InvalidPlanError) return { status: 'invalid_plan', reason: error.reason };
        throw error;
      }
      return {
        status: 'ok',
        completedSteps: completed,
        remainingSteps: remaining,
        progress: planProgress(params.plan, completed),
        outputs: toOutputMap(checkpoints),
      };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

/** Step outputs by step name. Steps that recorded nothing are ABSENT rather than present-and-empty. */
function toOutputMap(checkpoints: readonly JobCheckpointRow[]): Readonly<Record<string, Record<string, unknown>>> {
  const map: Record<string, Record<string, unknown>> = {};
  for (const c of checkpoints) {
    if (c.output !== null) map[c.step_name] = c.output;
  }
  return map;
}

function opts(options: CheckpointOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}
