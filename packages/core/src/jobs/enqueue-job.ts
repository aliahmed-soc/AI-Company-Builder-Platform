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
import { validateJobRequest, jobEnqueued, type JobKind, type JobRequestFailure } from '@acbp/contracts';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import type { Logger } from '@acbp/observability';

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
  // The typed refusal (CDR-049 §3-G3.3). `reason` is the CLOSED contract union — never a message string, so a caller
  // can switch exhaustively and an alarm can key on `missing_company` specifically.
  | { readonly status: 'refused'; readonly reason: JobRequestFailure };

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
        // Logged at WARN because a context-stripped enqueue is a defect somewhere upstream, not routine input error.
        // The reason is a closed enum, so this carries no caller data.
        options.logger?.warn('job.enqueue_refused', { metadata: { reason: validated.reason } });
        return { status: 'refused', reason: validated.reason };
      }
      const request = validated.value;

      const jobs = new JobRepository(scope.db);
      const inserted = await jobs.insert({
        accountId: request.accountId,
        companyId: request.companyId,
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
          options.logger?.warn('job.enqueue_conflict_unresolved', { metadata: { kind: request.kind } });
          return { status: 'refused', reason: 'invalid_idempotency_key' };
        }
        // Audited even though no row was created: an enqueue attempt that collapsed into an existing job is exactly
        // the event a run trail would otherwise be missing, and the caller was told `ok`.
        await audit(scope, jobEnqueued({ jobId: existing.id, kind: request.kind, deduplicated: true }), auditCtx(options));
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
