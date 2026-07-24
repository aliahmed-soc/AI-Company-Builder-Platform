// @acbp/core — interview session use cases (ACBP-P2-001; CDR-022; DISC-007; WORKFLOW-STATE-MACHINES §2).
//
// The durable founder-discovery session envelope. Every op runs under the caller's validated CompanyScope
// (runInCompanyScope) on the restricted `acbp_app` role: the caller's ACTIVE company-membership role is
// resolved first, the ADR-022 role check gates the action (interview:read / interview:participate — any active
// company member), and the mutation runs RLS-confined to the company. The state machine is SERVER-ENFORCED:
// every transition is validated against the @acbp/contracts legal-transition map, and the repository UPDATE
// carries the `from`-state predicate so a concurrent transition cannot double-apply (optimistic backstop).
//
// P2-001 implements the entry + exact-resume operations only: start (not_started→in_progress, emitting
// interview.started in the SAME transaction so a write failure rolls the session back), suspend
// (in_progress→waiting_for_user) and resume (waiting_for_user→in_progress), plus the read. The
// ready_for_review/confirmed/superseded transitions are legal members of the contract's machine whose effects
// belong to later M2/M3 tickets (CDR-022 §1). A company has at most one OPEN (non-superseded) session, so the
// operations target that open session — the caller never needs a session id.
import { InterviewSessionRepository, CompanyRepository, writeAuditEvent, type DatabaseClient, type AuditScope, type AuditWriteContext, type InterviewSessionRow } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import {
  interviewStarted,
  isInterviewSessionState,
  isLegalInterviewTransition,
  toInterviewDisplayPhase,
  type AuditEvent,
  type InterviewSessionDTO,
  type InterviewSessionState,
} from '@acbp/contracts';
import type { MemberRole } from '../members/roles.js';
import type { Logger } from '@acbp/observability';

// Local test-seam type (identical shape to the company module's; kept un-exported).
type AuditWriteFn = (scope: AuditScope, event: AuditEvent, ctx?: AuditWriteContext) => Promise<string>;

export interface InterviewSessionParams {
  /** Server-verified internal user id (NEVER a browser claim). */
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}

export interface InterviewSessionOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  /** TEST SEAM ONLY: override the in-tx audit writer to force a failure (prove the start rolls back). */
  readonly auditWriter?: AuditWriteFn;
}

export type StartInterviewResult =
  | { readonly status: 'ok'; readonly session: InterviewSessionDTO; readonly created: boolean }
  | { readonly status: 'forbidden' }
  | { readonly status: 'company_not_active' };

export type InterviewTransitionResult =
  | { readonly status: 'ok'; readonly session: InterviewSessionDTO }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'invalid_transition'; readonly from: InterviewSessionState };

export type GetInterviewResult = { readonly status: 'ok'; readonly session: InterviewSessionDTO } | { readonly status: 'forbidden' } | { readonly status: 'not_found' };

// ── start (not_started → in_progress) ──────────────────────────────────────────────────────────────────
/**
 * Start (or return) the company's interview session. Precondition (WORKFLOW §2): the company is `active` — an
 * interview cannot begin on a draft/onboarding/paused company. Idempotent: if an OPEN session already exists it
 * is returned (`created: false`) rather than creating a second (which the partial unique index would reject).
 * On a fresh start the `interview.started` audit is written in the SAME transaction as the insert.
 */
export async function startInterviewSession(client: DatabaseClient, params: InterviewSessionParams, options: InterviewSessionOptions = {}): Promise<StartInterviewResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<StartInterviewResult> => {
      if (checkAuthorization(role, 'interview:participate', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') {
        return { status: 'forbidden' };
      }
      const company = await new CompanyRepository(scope.db).findById(params.companyId);
      // A resolved company member always sees the company; a non-active company blocks the interview start.
      if (company === undefined || company.status !== 'active') return { status: 'company_not_active' };

      const repo = new InterviewSessionRepository(scope.db);
      const existing = await repo.findOpen(params.companyId);
      if (existing !== undefined) return { status: 'ok', session: toDTO(existing), created: false };

      // Insert-if-absent: ON CONFLICT DO NOTHING on the one-open-session partial index makes a CONCURRENT
      // first-start graceful — the loser inserts nothing and returns the winner's open session (created: false),
      // never a 23505/500 (security review LOW).
      const row = await repo.insertStartedIfAbsent(params.accountId, params.companyId);
      if (row === undefined) {
        const raced = await repo.findOpen(params.companyId);
        return raced !== undefined ? { status: 'ok', session: toDTO(raced), created: false } : { status: 'forbidden' };
      }
      // interview.started in the SAME transaction — a write failure rolls the insert back (no orphaned session).
      // Written ONLY for a genuinely new session (the conflict path above created nothing to audit).
      await audit(scope, interviewStarted({ sessionId: row.id }), auditContext(options));
      options.logger?.info('interview.started', { metadata: { accountId: params.accountId, companyId: params.companyId } });
      return { status: 'ok', session: toDTO(row), created: true };
    },
    optionsFor(options),
  );
  return unwrap(run);
}

// ── suspend / resume (in_progress ⇄ waiting_for_user) ──────────────────────────────────────────────────
export function suspendInterviewSession(client: DatabaseClient, params: InterviewSessionParams, options: InterviewSessionOptions = {}): Promise<InterviewTransitionResult> {
  return applyTransition(client, params, 'waiting_for_user', options);
}
export function resumeInterviewSession(client: DatabaseClient, params: InterviewSessionParams, options: InterviewSessionOptions = {}): Promise<InterviewTransitionResult> {
  return applyTransition(client, params, 'in_progress', options);
}

/** Apply a state transition to the company's OPEN session, guarded by the legal-transition map + the row's
 *  current state (optimistic concurrency — the UPDATE only fires when the row is still in `from`). */
async function applyTransition(client: DatabaseClient, params: InterviewSessionParams, toState: InterviewSessionState, options: InterviewSessionOptions): Promise<InterviewTransitionResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<InterviewTransitionResult> => {
      if (checkAuthorization(role, 'interview:participate', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') {
        return { status: 'forbidden' };
      }
      const repo = new InterviewSessionRepository(scope.db);
      const open = await repo.findOpen(params.companyId);
      if (open === undefined || !isInterviewSessionState(open.state)) return { status: 'not_found' };
      const from = open.state;
      if (!isLegalInterviewTransition(from, toState)) return { status: 'invalid_transition', from };
      const n = await repo.transition(open.id, from, toState);
      if (n === 0) return { status: 'invalid_transition', from }; // raced: the row left `from` first
      const updated = await repo.findById(open.id);
      if (updated === undefined) return { status: 'not_found' };
      return { status: 'ok', session: toDTO(updated) };
    },
    optionsFor(options),
  );
  return unwrap(run);
}

// ── read ────────────────────────────────────────────────────────────────────────────────────────────
/** The company's current (OPEN) interview session, or `not_found` when none has been started. */
export async function getInterviewSession(client: DatabaseClient, params: InterviewSessionParams, options: InterviewSessionOptions = {}): Promise<GetInterviewResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<GetInterviewResult> => {
      if (checkAuthorization(role, 'interview:read', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') {
        return { status: 'forbidden' };
      }
      const open = await new InterviewSessionRepository(scope.db).findOpen(params.companyId);
      if (open === undefined) return { status: 'not_found' };
      return { status: 'ok', session: toDTO(open) };
    },
    optionsFor(options),
  );
  return unwrap(run);
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────
function auditContext(options: InterviewSessionOptions): AuditWriteContext {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}
function optionsFor(options: InterviewSessionOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}

/** Redacted DTO. `state` is CHECK-guaranteed valid; `phase` is the honest projection (unknown → 'unknown'). */
function toDTO(row: InterviewSessionRow): InterviewSessionDTO {
  const state: InterviewSessionState = isInterviewSessionState(row.state) ? row.state : 'not_started';
  return {
    sessionId: row.id,
    companyId: row.company_id,
    state,
    phase: toInterviewDisplayPhase(row.state),
    startedAt: row.started_at === null ? null : new Date(row.started_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** A resolver denial collapses to a coarse `forbidden` (no membership/existence oracle). */
function unwrap<T extends { status: string }>(run: { kind: 'ran'; value: T; role: MemberRole } | { kind: 'denied'; reason: string }): T | { status: 'forbidden' } {
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
