// @acbp/core — bounded retry and dead-lettering (ACBP-P5-001c; CDR-052; NFR-007; ADR-008).
//
// Two use cases:
//   - recordJobFailure — one attempt failed; decide retry vs dead-letter and record it atomically;
//   - listBlockedJobs  — the Decision Room blocked queue, which is what makes "dead-letter" VISIBLE rather than a
//                        state nobody can find.
//
// THE FAILURE THIS EXCLUDES is a job retried without limit, and its quieter sibling: a job that exhausts its cap and
// is retried anyway because the decision and the recording were separate steps. So the decision is made by a pure
// function returning a CLOSED outcome, and the recording is a single guarded statement — there is no point at which a
// caller holds a counter and decides for itself (CDR-052 §3-G1).
import { JobRepository, writeAuditEvent, type DatabaseClient, type AuditWriteContext, type JobRow } from '@acbp/database';
import { classifyRetryOutcome, DEFAULT_RETRY_POLICY, isTerminalJobState, jobDeadLettered, type RetryPolicy, type JobFailureReason } from '@acbp/contracts';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import type { Logger } from '@acbp/observability';

export interface RetryOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  readonly auditWriter?: typeof writeAuditEvent;
  /** NFR-007's "config caps" hook. Defaults to the platform policy. */
  readonly retryPolicy?: RetryPolicy;
}

export interface RecordJobFailureParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly jobId: string;
  /** Why this attempt failed. CLOSED category — never provider exception text. */
  readonly reason: JobFailureReason;
}

export type RecordJobFailureResult =
  | { readonly status: 'retry_scheduled'; readonly attempts: number; readonly delayMs: number }
  // TERMINAL and visible. The job is now in the blocked queue, and nothing in this module will move it out.
  | { readonly status: 'dead_lettered'; readonly attempts: number; readonly reason: JobFailureReason }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  // The guarded update matched nothing: the job left `running` between our read and our write — an owner cancelled
  // it, or another worker already decided. Reporting this rather than retrying is the point; a job whose fate someone
  // else settled must not be dragged back into the queue.
  | { readonly status: 'state_changed' }
  // The job already reached a terminal state. Reported, and NOTHING is written - not the counter, not an audit row.
  | { readonly status: 'already_terminal'; readonly state: string };

/**
 * Record a failed attempt and decide what happens next.
 *
 * The decision comes from `classifyRetryOutcome`, which is pure and exhaustively tested, and FAILS CLOSED on a corrupt
 * counter or an unbounded policy. The write is a single guarded statement that increments `attempts` in SQL, so two
 * concurrent failures cannot each read the same count and hand the job an extra attempt.
 */
export async function recordJobFailure(client: DatabaseClient, params: RecordJobFailureParams, options: RetryOptions = {}): Promise<RecordJobFailureResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<RecordJobFailureResult> => {
      if (checkAuthorization(role, 'job:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };

      const jobs = new JobRepository(scope.db);
      const job = await jobs.findById(params.jobId);
      if (job === undefined) return { status: 'not_found' };

      // A job whose fate is already settled accepts NOTHING further. Found in review pass 1: without this, the
      // guard below (which matches on the job's CURRENT state) happily matched a dead-lettered job, incremented
      // `attempts` past the cap, and emitted ANOTHER `job.dead_lettered` audit row - unbounded, once per call.
      // A confused runner in a loop would inflate the counter and pollute the run trail indefinitely.
      if (isTerminalJobState(job.state)) return { status: 'already_terminal', state: job.state };

      // `attempts` counts completed attempts; the one that just failed is not yet counted, so the decision is made on
      // what the count WILL be. Getting this off by one is the difference between honouring the cap and exceeding it.
      const decision = classifyRetryOutcome(job.attempts + 1, policy);

      const updated = await jobs.recordAttemptOutcome({
        jobId: params.jobId,
        expectedState: job.state,
        nextState: decision.outcome === 'retry_scheduled' ? 'queued' : 'dead_letter',
        // The DB CHECK enforces the pairing, so a reason is written ONLY on the dead-letter transition. A retry that
        // carried one would be a row claiming to be both retryable and terminally failed.
        failureReason: decision.outcome === 'dead_lettered' ? params.reason : null,
      });
      if (updated === undefined) return { status: 'state_changed' };

      if (decision.outcome === 'dead_lettered') {
        // Audited in the SAME transaction (ADR-015). A dead-letter that is not recorded is a job that vanished from
        // the run trail at precisely the moment someone needs to know why it stopped.
        await audit(scope, jobDeadLettered({ jobId: params.jobId, kind: job.kind, attempts: updated.attempts, reason: params.reason }), auditCtx(options));
        options.logger?.warn('job.dead_lettered', { metadata: { companyId: params.companyId, kind: job.kind, attempts: updated.attempts, reason: params.reason } });
        return { status: 'dead_lettered', attempts: updated.attempts, reason: params.reason };
      }
      options.logger?.info('job.retry_scheduled', { metadata: { companyId: params.companyId, kind: job.kind, attempts: updated.attempts } });
      return { status: 'retry_scheduled', attempts: updated.attempts, delayMs: decision.delayMs };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── the blocked queue ───────────────────────────────────────────────────────────────────────────────────────

export interface ListBlockedJobsParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly limit?: number;
}

export interface BlockedJobDTO {
  readonly id: string;
  readonly kind: string;
  readonly attempts: number;
  readonly failureReason: string | null;
}

export type ListBlockedJobsResult = { readonly status: 'ok'; readonly jobs: readonly BlockedJobDTO[] } | { readonly status: 'forbidden' };

/** Default page size. Bounded so a company with many dead letters cannot ask for an unbounded read. */
const MAX_BLOCKED_PAGE = 100;

/**
 * The Decision Room blocked queue (FAILURE-AND-RECOVERY row 4: *"Dead-letter → Decision Room blocked queue"*).
 *
 * This read is what makes §3-G2's "never silently retried" meaningful: a terminal state nobody can enumerate is
 * indistinguishable from a job that quietly disappeared. NEVER exposes the payload — it carries caller-chosen
 * references and is not a reviewed surface.
 */
export async function listBlockedJobs(client: DatabaseClient, params: ListBlockedJobsParams, options: RetryOptions = {}): Promise<ListBlockedJobsResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ListBlockedJobsResult> => {
      if (checkAuthorization(role, 'job:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const requested = params.limit ?? MAX_BLOCKED_PAGE;
      const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_BLOCKED_PAGE) : MAX_BLOCKED_PAGE;
      const rows = await new JobRepository(scope.db).listDeadLettered(limit);
      return { status: 'ok', jobs: rows.map(toBlockedDTO) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

function toBlockedDTO(row: JobRow): BlockedJobDTO {
  return { id: row.id, kind: row.kind, attempts: row.attempts, failureReason: row.failure_reason };
}

function auditCtx(options: RetryOptions): AuditWriteContext {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}
function opts(options: RetryOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}
