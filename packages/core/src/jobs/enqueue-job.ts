// @acbp/core — durable job enqueue (ACBP-P5-001a; CDR-049 §3/§4; ADR-008; NFR-005/006; invariant 3).
//
// One use case: put a job in the store, stamped with the tenant context of the caller who asked for it, or REFUSE.
// Nothing here runs a job — P5-001b/c own execution, checkpoints and retry. That separation is what makes this
// sub-scope reviewable on its own: the store and its tenancy guarantee are complete before any runner exists.
//
// THE FAILURE THIS EXCLUDES is not a crash. It is a job that loses its tenant context somewhere in the enqueue path,
// gets a plausible default, and then executes successfully against the wrong tenant. Three redundant layers refuse it
// (CDR-049 §3-G3), and this file is the third:
//   1. `NOT NULL` on account_id/company_id — catches code that forgets the fields;
//   2. dual-keyed FORCE RLS `WITH CHECK` — catches a caller supplying SOMEONE ELSE'S ids, which NOT NULL cannot see;
//   3. `validateJobRequest` here — turns both into a typed reason a caller can act on and the platform can alarm on.
//
// Layer 3 does not make 1 and 2 redundant, and the redundancy is deliberate: this layer is bypassed by anything that
// reaches the repository directly, and the DB layers are the ones that still hold when it is.
import { JobRepository, writeAuditEvent, type DatabaseClient, type AuditWriteContext, type JobRow } from '@acbp/database';
import { validateJobRequest, validateJobTenancy, jobEnqueued, type JobKind, type JobRequestFailure, type AutonomousWorkRefusal } from '@acbp/contracts';
import { runInCompanyScope } from '../company/company-context-resolver.js';
// ACBP-P7-002: the lifecycle gate's read. Imported directly — not a port, no injectable answer.
import { readLifecycleDecision } from '../company/lifecycle-guard.js';
import { checkAuthorization } from '../authz/authz-service.js';
import { recordSuppression, type Logger } from '@acbp/observability';

export interface EnqueueJobOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  readonly auditWriter?: typeof writeAuditEvent;
}

export interface EnqueueJobParams {
  readonly userId: string;
  /**
   * Typed `string` for a well-behaved caller, but validated as untrusted all the same. A caller reaching this from
   * parsed JSON, a resumed workflow, or a retry payload can supply anything — including `undefined` — and the whole
   * point of this ticket is that such a request is refused rather than repaired.
   */
  readonly accountId: string;
  readonly companyId: string;
  readonly kind: string;
  readonly payload?: Record<string, unknown> | null;
  /** Optional. When present, the same key enqueued twice is ONE job (TASK-009/NFR-006). */
  readonly idempotencyKey?: string | null;
}

export interface EnqueuedJob {
  readonly id: string;
  readonly kind: JobKind;
  readonly state: string;
  readonly idempotencyKey: string | null;
}

export type EnqueueJobResult =
  // `deduplicated` distinguishes "we created this job" from "this job already existed" WITHOUT making the caller
  // compare ids. Both are successes and the caller usually treats them alike, but a caller that is counting work, or
  // deciding whether to notify someone, needs to know which happened.
  | { readonly status: 'ok'; readonly job: EnqueuedJob; readonly deduplicated: boolean }
  | { readonly status: 'forbidden' }
  /**
   * The COMPANY may not do autonomous work (ACBP-P7-002; CDR-079; launch **Gate 14**).
   *
   * DISTINCT FROM `forbidden`, which is an authorization answer about the ACTOR. This one says the actor was
   * entitled and the company was not in a state to receive the work — two different fixes, and conflating them
   * would send an owner to check their own permissions.
   */
  | { readonly status: 'company_not_active'; readonly reason: AutonomousWorkRefusal }
  // The typed refusal (CDR-049 §3-G3.3). `reason` is the CLOSED contract union — never a message string, so a caller
  // can switch exhaustively and an alarm can key on `missing_company` specifically.
  | { readonly status: 'refused'; readonly reason: JobRequestFailure }
  // The idempotency index conflicted but the conflicting row could not then be read. Its own status rather than a
  // `refused` reason, because NOTHING about the request was wrong: reporting `invalid_idempotency_key` here would tell
  // the caller to change a key that was correct, and they would retry forever. Should be unreachable (a conflict
  // implies a committed row visible to this transaction) — which is exactly why it must be distinguishable if it ever
  // happens rather than folded into a plausible-sounding neighbour.
  | { readonly status: 'conflict_unresolved' };

function toEnqueuedJob(row: JobRow, kind: JobKind): EnqueuedJob {
  // `kind` comes from the VALIDATED request rather than the row: the row's column is plain text, and narrowing it
  // back to `JobKind` would be an unchecked cast asserting something the database never promised.
  return { id: row.id, kind, state: row.state, idempotencyKey: row.idempotency_key };
}

/**
 * Enqueue a durable job under the caller's company scope, or refuse with a typed reason.
 *
 * OWNER-ONLY (`job:enqueue`): a job runs later, on its own, after the session that authorized it is gone, so this is
 * deliberately the tighter of the two readings canon leaves open (see the action's note in the authz policy).
 *
 * ORDER MATTERS. Authorization is checked BEFORE validation, so a caller who may not enqueue at all learns nothing
 * about which of their fields were well-formed — a refusal reason is a small oracle, and it should only be available
 * to someone already entitled to the operation.
 */
export async function enqueueJob(client: DatabaseClient, params: EnqueueJobParams, options: EnqueueJobOptions = {}): Promise<EnqueueJobResult> {
  const audit = options.auditWriter ?? writeAuditEvent;

  // TENANCY IS CHECKED BEFORE THE SCOPE IS RESOLVED. Found in review pass 1: `runInCompanyScope` denies an absent or
  // blank company id itself, so with this check inside the scope the acceptance clause's refusal was UNREACHABLE — a
  // context-stripped enqueue came back as `forbidden`, which is what an authorization failure looks like. The one
  // failure this sub-scope exists to make visible would have been the one failure it hid.
  //
  // Only the tenancy fields move ahead of authorization, and only because they leak nothing: they report on the shape
  // of ids the CALLER supplied, not on platform state. `invalid_kind` and `payload_too_large` stay behind the authz
  // check, where a refusal reason would be an oracle.
  const tenancy = validateJobTenancy({ accountId: params.accountId, companyId: params.companyId });
  if (!tenancy.ok) {
    // WARN, not INFO: a context-stripped enqueue is a defect upstream, not routine bad input. The reason is a closed
    // enum, so this carries no caller data.
    options.logger?.warn('job.enqueue_refused', { metadata: { reason: tenancy.reason } });
    return { status: 'refused', reason: tenancy.reason };
  }

  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<EnqueueJobResult> => {
      if (checkAuthorization(role, 'job:enqueue', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };

      const validated = validateJobRequest({
        accountId: params.accountId,
        companyId: params.companyId,
        kind: params.kind,
        payload: params.payload,
        idempotencyKey: params.idempotencyKey,
        createdByUserId: params.userId,
      });
      if (!validated.ok) {
        options.logger?.warn('job.enqueue_refused', { metadata: { reason: validated.reason } });
        return { status: 'refused', reason: validated.reason };
      }
      const request = validated.value;

      const jobs = new JobRepository(scope.db);

      // ACBP-P7-002 / CDR-079 / launch **Gate 14**: a job enqueued is autonomous work CREATED, even though a
      // human triggers it — `authz.ts` says it plainly: *"a job runs later, on its own, after the authorizing
      // session is gone."* A job never enqueued can never be picked up.
      //
      // BUT A REPLAY IS NOT NEW WORK, AND THIS IS THE SUBTLE PART (CDR-079 §6-G5). The dedupe below is
      // INSERT-FIRST: you learn a request is a duplicate by attempting the insert. So gating naively before the
      // insert would refuse a retry of an enqueue that ALREADY SUCCEEDED before the pause, and the caller could
      // never learn their job exists — breaking NFR-006 replay safety with a control meant to stop new work.
      // Gating after the insert would be worse: the job would already exist.
      //
      // So the refusal path asks the idempotency question FIRST. A key that already names a job answers with that
      // job; only a genuinely NEW request is refused. Nothing is inserted for a company that may not act.
      const lifecycle = await readLifecycleDecision(scope);
      if (!lifecycle.allowed) {
        const alreadyEnqueued = request.idempotencyKey === null ? undefined : await jobs.findByIdempotencyKey(request.idempotencyKey);
        if (alreadyEnqueued !== undefined) {
          // AUDITED AND COUNTED, exactly like the dedupe branch below — the independent review caught that this
          // one did neither. The rationale there transfers verbatim and was already written down: an enqueue that
          // collapsed into an existing job "is exactly the event a run trail would otherwise be missing, and the
          // caller was told `ok`". Being ALSO lifecycle-blocked changes nothing about that: the caller still got
          // `ok`, so the trail still owes the record. Two `status: 'ok'` paths that differ in what they record is
          // how a run trail acquires a hole nobody can see.
          await audit(scope, jobEnqueued({ jobId: alreadyEnqueued.id, kind: request.kind, deduplicated: true }), auditCtx(options));
          recordSuppression(options.logger, { surface: 'job_enqueue', accountId: scope.tenant.accountId, companyId: scope.tenant.companyId });
          options.logger?.info('job.enqueue_replayed_while_blocked', { metadata: { jobId: alreadyEnqueued.id, kind: request.kind, reason: lifecycle.reason } });
          return { status: 'ok', job: toEnqueuedJob(alreadyEnqueued, request.kind), deduplicated: true };
        }
        options.logger?.info('job.enqueue_refused_lifecycle', { metadata: { accountId: scope.tenant.accountId, companyId: scope.tenant.companyId, kind: request.kind, reason: lifecycle.reason } });
        return { status: 'company_not_active', reason: lifecycle.reason };
      }

      // STAMPED FROM THE RESOLVED SCOPE, not from `request`. Both are equal here — `runInCompanyScope` verified
      // membership against exactly the ids the caller passed — but they are equal by coincidence of this call path,
      // and this is the one ticket whose entire purpose is that a job's tenancy is not a caller's claim. Reading the
      // scope means a future caller who supplies ids that differ from the scope they actually hold cannot produce a
      // row stamped with the claim rather than the grant, without anyone having to notice.
      const inserted = await jobs.insert({
        accountId: scope.tenant.accountId,
        companyId: scope.tenant.companyId,
        kind: request.kind,
        payload: request.payload,
        idempotencyKey: request.idempotencyKey,
        createdByUserId: request.createdByUserId,
      });

      if (inserted === undefined) {
        // The partial unique index fired: this company already has a job under this key. Read it back rather than
        // assuming — the read is RLS-confined, so the "already enqueued" answer can only ever be this company's own
        // job. A null key cannot reach here (the index is partial), but the guard keeps that a fact rather than an
        // inference for whoever changes the index next.
        const existing = request.idempotencyKey === null ? undefined : await jobs.findByIdempotencyKey(request.idempotencyKey);
        if (existing === undefined) {
          // The insert wrote nothing AND nothing is there to find. Reporting `ok` would claim a job that does not
          // exist, and callers would wait for work that will never run.
          options.logger?.error('job.enqueue_conflict_unresolved', { metadata: { kind: request.kind } });
          return { status: 'conflict_unresolved' };
        }
        // Audited even though no row was created: an enqueue attempt that collapsed into an existing job is exactly
        // the event a run trail would otherwise be missing, and the caller was told `ok`.
        await audit(scope, jobEnqueued({ jobId: existing.id, kind: request.kind, deduplicated: true }), auditCtx(options));
        // Counted as well as audited (ACBP-P6-011; CDR-074 §0). The audit row answers "what happened to THIS job",
        // which is a per-job question; the incident answers "is suppression firing at all", which is a
        // cross-surface one. Neither substitutes for the other, and only the second distinguishes a working
        // mechanism from a quiet one.
        recordSuppression(options.logger, { surface: 'job_enqueue', accountId: scope.tenant.accountId, companyId: scope.tenant.companyId });
        return { status: 'ok', job: toEnqueuedJob(existing, request.kind), deduplicated: true };
      }

      // Audit-or-nothing (ADR-015): same transaction as the row, so a job cannot exist without the record of who
      // scheduled it. The payload never enters the audit metadata.
      await audit(scope, jobEnqueued({ jobId: inserted.id, kind: request.kind, deduplicated: false }), auditCtx(options));
      options.logger?.info('job.enqueued', { metadata: { accountId: request.accountId, companyId: request.companyId, kind: request.kind } });
      return { status: 'ok', job: toEnqueuedJob(inserted, request.kind), deduplicated: false };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

function auditCtx(options: EnqueueJobOptions): AuditWriteContext {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}
function opts(options: EnqueueJobOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}
