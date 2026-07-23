// @acbp/core — workspace-provisioning use cases (ACBP-P1-012; CDR-018; COMP-002/003). API-only.
//
// Request-driven, SEQUENTIAL, checkpointed execution of the six canonical workspace-provisioning steps:
//
//   - EVERY entry (read, resume, each step, the completion transition) runs through a FRESH
//     `runInCompanyScope` — fresh membership validation, fresh CompanyScope, its own transaction. No worker,
//     queue, detached task, polling loop, lease, daemon, or outbox exists — the only drivers are the
//     post-create inline invocation and the owner's explicit resume request.
//   - A step transaction: locks its checkpoint row FOR UPDATE → re-checks status/attempt under the lock
//     (concurrent resumes serialize here: completed rows are skipped idempotently, no double attempt
//     increment, no duplicate effect) → writes the `provisioning.step_started` audit → performs the step's
//     MATERIAL EFFECT → commits the durable outcome (completed | failed, attempt+1, timestamps, closed
//     failure code) + the outcome audit ATOMICALLY. A `running` state is never committed; an unexpected error
//     rolls the whole step transaction back, leaving the previous durable checkpoint unchanged
//     (kill-and-resume by construction).
//   - Attempts are bounded to 3 TOTAL per step; a step failed at the cap is EXHAUSTED — resume performs no
//     mutation and reports a safe conflict.
//   - When all six steps are completed, a SEPARATE fresh transaction locks the checkpoints + the company row,
//     proves the gate (all six completed AND status onboarding), transitions onboarding→active, and writes
//     `provisioning.completed` atomically (idempotent when already active with all steps completed; fails
//     closed on any other state).
//
// Audit actor semantics (CDR-018 §8): step execution and lifecycle transitions are SYSTEM actions
// (`actor_type = 'system'`; the scope-bound `actor_id` remains the server-verified user whose request drove
// the execution — provenance, never authority). Only `provisioning.retry_requested` is a USER action, and the
// system step events of a retry run reference it via `causation_id`. All six provisioning events are
// AUDIT-ONLY: none is ever projected into `activity_events` (the projector's closed taxonomy excludes them).
import {
  CompanyRepository,
  CompanyProfileRepository,
  ProvisioningRepository,
  WorkspaceAreaRepository,
  writeAuditEvent,
  type DatabaseClient,
  type TenantScope,
  type ProvisioningStepRow,
} from '@acbp/database';
import {
  PROVISIONING_STEPS,
  PROVISIONING_RESULT_CODES,
  MAX_PROVISIONING_ATTEMPTS,
  deriveProvisioningFlags,
  isProvisioningStepName,
  isProvisioningStepStatus,
  isProvisioningFailureCode,
  provisioningStarted,
  provisioningStepStarted,
  provisioningStepCompleted,
  provisioningStepFailed,
  provisioningRetryRequested,
  provisioningCompleted,
  isCompanyStatus,
  platformError,
  ErrorCodes,
  type ProvisioningStepLike,
  type ProvisioningStepName,
  type ProvisioningFailureCode,
  type ProvisioningStepDTO,
  type ProvisioningStatusDTO,
} from '@acbp/contracts';
import { runInCompanyScope } from './company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import type { AuditWriteFn } from './company-service.js';
import type { Logger } from '@acbp/observability';

/** The outcome a step's MATERIAL EFFECT reports (closed result/failure codes — never free text). */
export type StepEffectOutcome = { readonly ok: true; readonly resultCode: string } | { readonly ok: false; readonly failureCode: ProvisioningFailureCode };
/** One step's material effect, running INSIDE the step's CompanyScope transaction. */
export type StepEffectFn = (scope: TenantScope, ctx: { readonly accountId: string; readonly companyId: string }) => Promise<StepEffectOutcome>;

export interface ProvisioningOpOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  /** TEST SEAM ONLY: override the in-tx audit writer to force a failure. Never set in production. */
  readonly auditWriter?: AuditWriteFn;
  /** TEST SEAM ONLY: override individual step effects (force controlled failures / observe sequencing). */
  readonly stepEffects?: Partial<Record<ProvisioningStepName, StepEffectFn>>;
}

export interface ProvisioningParams {
  /** Server-verified internal user id. NEVER a browser claim. */
  readonly userId: string;
  readonly accountId: string;
  /** A REQUEST selector — validated against an active company membership on every entry. */
  readonly companyId: string;
}

export type GetProvisioningResult = { readonly status: 'ok'; readonly provisioning: ProvisioningStatusDTO } | { readonly status: 'forbidden' };
export type ResumeProvisioningResult =
  | { readonly status: 'ok'; readonly provisioning: ProvisioningStatusDTO }
  | { readonly status: 'conflict' }
  | { readonly status: 'forbidden' };

// ── Material step effects (CDR-018 §6) — a step NEVER completes unless its effect/verification succeeded ────

function areaEffect(area: ProvisioningStepName): StepEffectFn {
  return async (scope, ctx) => {
    // Idempotent minimal-registry INSERT (ON CONFLICT DO NOTHING) — a re-run never duplicates or errors.
    await new WorkspaceAreaRepository(scope.db).insertArea(ctx.accountId, ctx.companyId, area);
    return { ok: true, resultCode: PROVISIONING_RESULT_CODES[area] };
  };
}

const DEFAULT_EFFECTS: Readonly<Record<ProvisioningStepName, StepEffectFn>> = {
  // VERIFICATION step: the deterministic current profile revision must exist (created by the P1-010 bootstrap).
  // No duplicate profile object is ever created here.
  profile: async (scope, ctx) => {
    const current = await new CompanyProfileRepository(scope.db).currentRevision(ctx.companyId);
    return current !== undefined ? { ok: true, resultCode: PROVISIONING_RESULT_CODES.profile } : { ok: false, failureCode: 'profile_missing' };
  },
  mission_draft: areaEffect('mission_draft'),
  research: areaEffect('research'),
  roadmap: areaEffect('roadmap'),
  documents: areaEffect('documents'),
  // VERIFICATION step: the company.created activity projection must exist AND match its authoritative audit
  // event identity (same event id, same company). No synthetic activity event is ever emitted.
  activity: async (scope, ctx) => {
    const rows = await scope.db
      .selectFrom('activity_events as act')
      .innerJoin('audit_events as ae', 'ae.event_id', 'act.event_id')
      .select('act.event_id')
      .where('act.company_id', '=', ctx.companyId)
      .where('act.activity_type', '=', 'company.created')
      .where('ae.name', '=', 'company.created')
      .where('ae.company_id', '=', ctx.companyId)
      .execute();
    return rows.length > 0 ? { ok: true, resultCode: PROVISIONING_RESULT_CODES.activity } : { ok: false, failureCode: 'activity_projection_missing' };
  },
};

// ── Row → contract mapping ───────────────────────────────────────────────────────────────────────────────────

/** Narrow durable rows to the contract's step-like shape (defensive: DB CHECKs make invalid rows unreachable;
 *  any invalid row is dropped, which makes the flag derivation fail CLOSED — not completed, not resumable). */
function toStepLikes(rows: readonly ProvisioningStepRow[]): ProvisioningStepLike[] {
  const out: ProvisioningStepLike[] = [];
  for (const r of rows) {
    if (isProvisioningStepName(r.step) && isProvisioningStepStatus(r.status)) out.push({ step: r.step, status: r.status, attempt: r.attempt });
  }
  return out;
}

function toStepDTO(row: ProvisioningStepRow): ProvisioningStepDTO | null {
  if (!isProvisioningStepName(row.step) || !isProvisioningStepStatus(row.status)) return null;
  const failureCode = row.failure_code !== null && isProvisioningFailureCode(row.failure_code) ? row.failure_code : null;
  return {
    step: row.step,
    order: row.step_order,
    status: row.status,
    attempt: row.attempt,
    requestedAt: row.requested_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    failedAt: row.failed_at?.toISOString() ?? null,
    failureCode,
  };
}

function buildStatusDTO(companyId: string, companyStatus: string, rows: readonly ProvisioningStepRow[]): ProvisioningStatusDTO {
  const steps = rows.map(toStepDTO).filter((s): s is ProvisioningStepDTO => s !== null).sort((a, b) => a.order - b.order);
  const flags = deriveProvisioningFlags(steps);
  return {
    companyId,
    companyStatus: isCompanyStatus(companyStatus) ? companyStatus : 'unknown',
    steps,
    nextIncompleteStep: flags.nextIncompleteStep,
    resumable: flags.resumable,
    exhausted: flags.exhausted,
    completed: flags.completed,
  };
}

function opts(options: ProvisioningOpOptions): { correlationId?: string } {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}

// ── Read use case ────────────────────────────────────────────────────────────────────────────────────────────

/** Read the ordered six-step provisioning status. Any active company member (owner|viewer). */
export async function getProvisioningStatus(client: DatabaseClient, params: ProvisioningParams, options: ProvisioningOpOptions = {}): Promise<GetProvisioningResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<GetProvisioningResult> => {
      if (checkAuthorization(role, 'provisioning:read', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') {
        return { status: 'forbidden' };
      }
      const company = await new CompanyRepository(scope.db).findById(params.companyId);
      if (company === undefined) return { status: 'forbidden' };
      const rows = await new ProvisioningRepository(scope.db).listSteps(params.companyId);
      return { status: 'ok', provisioning: buildStatusDTO(params.companyId, company.status, rows) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── Step executor ────────────────────────────────────────────────────────────────────────────────────────────

type StepOutcome = 'completed_step' | 'failed_step' | 'exhausted' | 'all_completed' | 'inconsistent' | 'denied';

/**
 * Execute AT MOST ONE step in a fresh CompanyScope transaction (see the module header for the full protocol).
 * `causationId` ties the system step events of a retry run back to the user's `retry_requested` audit event.
 */
async function executeNextStep(client: DatabaseClient, params: ProvisioningParams, causationId: string | undefined, options: ProvisioningOpOptions): Promise<StepOutcome> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope): Promise<StepOutcome> => {
      const repo = new ProvisioningRepository(scope.db);
      const flags = deriveProvisioningFlags(toStepLikes(await repo.listSteps(params.companyId)));
      if (flags.completed) return 'all_completed';
      if (flags.exhausted) return 'exhausted';
      const next = flags.nextIncompleteStep;
      if (next === null) return 'inconsistent'; // malformed checkpoint set — fail closed, no mutation

      // Serialize on the row; re-check AFTER the lock (a concurrent resume may have advanced this step).
      const row = await repo.lockStep(params.companyId, next);
      if (row === undefined) return 'inconsistent';
      if (row.status === 'completed') return 'completed_step'; // another request completed it — skip idempotently
      if (row.status === 'failed' && row.attempt >= MAX_PROVISIONING_ATTEMPTS) return 'exhausted';
      const fromAttempt = row.attempt;
      const attempt = fromAttempt + 1;
      const auditCtx = { actorType: 'system' as const, ...(causationId !== undefined ? { causationId } : {}), ...opts(options) };

      // Chronology: the started audit precedes the effect, but ALL of it commits (or rolls back) together —
      // an unexpected effect error therefore leaves NO committed trace of this attempt (no fake progress).
      await audit(scope, provisioningStepStarted({ companyId: params.companyId, step: next, attempt }), auditCtx);
      const effect = options.stepEffects?.[next] ?? DEFAULT_EFFECTS[next];
      const outcome = await effect(scope, { accountId: params.accountId, companyId: params.companyId });

      if (outcome.ok) {
        const updated = await repo.completeStep(params.companyId, next, fromAttempt);
        if (updated !== 1) {
          // Unreachable under the row lock — defensive: abort the whole step transaction (no partial state).
          throw platformError('conflict', { code: ErrorCodes.CONFLICT_DETECTED, internalMessage: 'Provisioning step outcome guard failed under lock.' });
        }
        await audit(scope, provisioningStepCompleted({ companyId: params.companyId, step: next, attempt, resultCode: outcome.resultCode }), auditCtx);
        options.logger?.info('provisioning.step_completed', { metadata: { companyId: params.companyId, step: next, attempt } });
        return 'completed_step';
      }
      const updated = await repo.failStep(params.companyId, next, fromAttempt, outcome.failureCode);
      if (updated !== 1) {
        throw platformError('conflict', { code: ErrorCodes.CONFLICT_DETECTED, internalMessage: 'Provisioning step outcome guard failed under lock.' });
      }
      await audit(scope, provisioningStepFailed({ companyId: params.companyId, step: next, attempt, failureCode: outcome.failureCode }), auditCtx);
      options.logger?.warn('provisioning.step_failed', { metadata: { companyId: params.companyId, step: next, attempt, failureCode: outcome.failureCode } });
      return 'failed_step';
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : 'denied';
}

/**
 * The COMPLETION transition (CDR-018 §7): a separate fresh transaction that locks the six checkpoints + the
 * company row, PROVES the gate (all six completed AND status onboarding), transitions onboarding→active, and
 * writes `provisioning.completed` atomically. Idempotent when already active with all steps completed; THROWS
 * (rolling back, mutating nothing) on any other state — no step failure or acknowledgement can ever activate.
 */
async function completeProvisioning(client: DatabaseClient, params: ProvisioningParams, options: ProvisioningOpOptions): Promise<'done' | 'denied'> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope): Promise<'done'> => {
      const repo = new ProvisioningRepository(scope.db);
      const steps = await repo.lockSteps(params.companyId);
      const company = await scope.db.selectFrom('companies').selectAll().where('id', '=', params.companyId).forUpdate().executeTakeFirst();
      if (company === undefined) {
        throw platformError('internal', { code: ErrorCodes.INTERNAL_ERROR, internalMessage: 'Company not visible during provisioning completion.' });
      }
      const allCompleted = steps.length === PROVISIONING_STEPS.length && steps.every((s) => s.status === 'completed');
      if (!allCompleted) {
        throw platformError('internal', { code: ErrorCodes.INTERNAL_ERROR, internalMessage: 'Provisioning completion gate failed: not all steps are completed.' });
      }
      if (company.status === 'active') return 'done'; // already activated with all steps completed — idempotent
      if (company.status !== 'onboarding') {
        throw platformError('internal', { code: ErrorCodes.INTERNAL_ERROR, internalMessage: 'Provisioning completion gate failed: company is not onboarding.' });
      }
      const transitioned = await new CompanyRepository(scope.db).updateStatus(params.companyId, 'active');
      if (transitioned === undefined) {
        throw platformError('internal', { code: ErrorCodes.INTERNAL_ERROR, internalMessage: 'Provisioning completion could not transition onboarding→active.' });
      }
      await audit(scope, provisioningCompleted({ companyId: params.companyId, stepCount: PROVISIONING_STEPS.length }), { actorType: 'system', ...opts(options) });
      options.logger?.info('provisioning.completed', { metadata: { companyId: params.companyId } });
      return 'done';
    },
    opts(options),
  );
  return run.kind === 'ran' ? 'done' : 'denied';
}

// ── Resume orchestration ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The single resume service (CDR-018 §3/§12): owner-only; processes steps in canonical order in fresh
 * per-step transactions; skips completed steps; halts on a controlled failure or an exhausted step; runs the
 * completion transition when all six are completed. Idempotent: already-completed provisioning returns the
 * truthful state with no mutation; already-EXHAUSTED provisioning returns a safe `conflict` with no mutation.
 * A backfilled DRAFT company is transitioned draft→onboarding (with `provisioning.started` emitted once, under
 * a company-row lock so concurrent resumes cannot double-start) before its first step. A PAUSED or otherwise
 * inconsistent state fails closed with no mutation.
 */
export async function resumeProvisioning(client: DatabaseClient, params: ProvisioningParams, options: ProvisioningOpOptions = {}): Promise<ResumeProvisioningResult> {
  const audit = options.auditWriter ?? writeAuditEvent;

  // Phase A (own transaction): authorize provisioning:resume (OWNER only) and gate on the current state under
  // a company-row lock; emit `provisioning.retry_requested` (USER actor) when this resume retries a failed step.
  type PhaseGate =
    | { readonly gate: 'proceed'; readonly retryEventId?: string }
    | { readonly gate: 'already_completed' }
    | { readonly gate: 'conflict' }
    | { readonly gate: 'forbidden' };
  const phaseA = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<PhaseGate> => {
      if (checkAuthorization(role, 'provisioning:resume', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') {
        return { gate: 'forbidden' };
      }
      // Lock the company row: concurrent resumes serialize here, so the draft→onboarding bring-up below and
      // the started-event once-only check cannot race.
      const company = await scope.db.selectFrom('companies').selectAll().where('id', '=', params.companyId).forUpdate().executeTakeFirst();
      if (company === undefined) return { gate: 'forbidden' };
      const repo = new ProvisioningRepository(scope.db);
      const rows = await repo.listSteps(params.companyId);
      const likes = toStepLikes(rows);
      const flags = deriveProvisioningFlags(likes);

      if (company.status === 'paused') return { gate: 'conflict' }; // canonically unreachable — never touch pause state
      if (flags.completed) {
        // All six completed: active → pure idempotent read; onboarding (crash before activation) → let Phase B
        // finish the activation; anything else is inconsistent → fail closed.
        if (company.status === 'active') return { gate: 'already_completed' };
        if (company.status === 'onboarding') return { gate: 'proceed' };
        return { gate: 'conflict' };
      }
      if (flags.exhausted) return { gate: 'conflict' }; // no mutation possible — safe conflict
      if (!flags.resumable) return { gate: 'conflict' }; // malformed/inconsistent checkpoint set — fail closed
      if (company.status === 'active') return { gate: 'conflict' }; // active with incomplete steps — fail closed

      if (company.status === 'draft') {
        // A backfilled pre-P1-012 company: bring it into onboarding before the first step (idempotent — the
        // locked read proved 'draft'; provisioning.started is emitted at most once).
        const transitioned = await new CompanyRepository(scope.db).updateStatus(params.companyId, 'onboarding');
        if (transitioned === undefined) {
          throw platformError('internal', { code: ErrorCodes.INTERNAL_ERROR, internalMessage: 'Backfilled company could not transition draft→onboarding.' });
        }
        const existing = await scope.db.selectFrom('audit_events').select('event_id').where('name', '=', 'provisioning.started').where('company_id', '=', params.companyId).executeTakeFirst();
        if (existing === undefined) {
          await audit(scope, provisioningStarted({ companyId: params.companyId, stepCount: PROVISIONING_STEPS.length }), { actorType: 'system', ...opts(options) });
        }
      }

      // A retry (the next incomplete step has FAILED before) is an explicit USER action — audited as such.
      const next = flags.nextIncompleteStep;
      const nextRow = next !== null ? likes.find((r) => r.step === next) : undefined;
      if (nextRow !== undefined && nextRow.status === 'failed') {
        const retryEventId = await audit(scope, provisioningRetryRequested({ companyId: params.companyId, step: nextRow.step, nextAttempt: nextRow.attempt + 1 }), { actorType: 'user', ...opts(options) });
        return { gate: 'proceed', retryEventId };
      }
      return { gate: 'proceed' };
    },
    opts(options),
  );
  if (phaseA.kind !== 'ran') return { status: 'forbidden' };
  const gate = phaseA.value;
  if (gate.gate === 'forbidden') return { status: 'forbidden' };
  if (gate.gate === 'conflict') return { status: 'conflict' };

  // Phase B: the sequential step loop — each step in its own fresh CompanyScope transaction. Bounded by the
  // step count + 1 (each iteration either advances or halts; it can never spin).
  if (gate.gate === 'proceed') {
    const causationId = gate.retryEventId;
    for (let i = 0; i < PROVISIONING_STEPS.length + 1; i++) {
      const outcome = await executeNextStep(client, params, causationId, options);
      if (outcome === 'denied') return { status: 'forbidden' }; // membership revoked mid-run — coarse denial
      if (outcome === 'completed_step') continue;
      if (outcome === 'all_completed') {
        if ((await completeProvisioning(client, params, options)) === 'denied') return { status: 'forbidden' };
      }
      break; // failed_step | exhausted | inconsistent | all_completed → stop the loop
    }
  }

  // Phase C: truthful final read (fresh transaction).
  const final = await getProvisioningStatus(client, params, options);
  if (final.status !== 'ok') return { status: 'forbidden' };
  return { status: 'ok', provisioning: final.provisioning };
}

/** Post-create inline invocation type (CDR-018 §10): `createCompany` awaits this after its transaction commits. */
export type ProvisioningRunnerFn = typeof resumeProvisioning;
