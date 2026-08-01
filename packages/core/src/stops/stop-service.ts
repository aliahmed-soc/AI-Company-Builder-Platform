// @acbp/core — the emergency-stop controller (ACBP-P6-007; CDR-072; ADMIN-001/002; COMP-006; trust-critical #9/#10).
//
// ⚠️ SEVEN SCOPES ARE NAMED; FIVE ARE ENFORCEABLE. `capability` and `integration` are refused here BY NAME
// (CDR-072 §1-G10) because the tool registry carries no identity for either, so no call could ever be matched
// against them. Accepting one would hand the operator a halt that does nothing — CDR-072 §0's failure, created by
// the very code meant to prevent it.
//
// THE TRANSACTION RULE THAT SHAPES EVERY FUNCTION HERE (§1-G8): `runInCompanyScope` runs its callback INSIDE the
// account transaction, so `return { status: 'refused' }` AFTER a write COMMITS that write. For a stop that is worse
// than for anything else in the codebase — the system would be PARTIALLY STOPPED while telling the operator it did
// not stop, so belief and state disagree in a way neither surfaces. Refusals before the first write are typed;
// anything after it THROWS.
import {
  STOP_SCOPES,
  ENFORCEABLE_STOP_SCOPES,
  NOT_YET_ENFORCEABLE_STOP_SCOPES,
  isStopScope,
  isEnforceableStopScope,
  emergencyStopActivated,
  emergencyStopCleared,
  emergencyStopWorkReviewed,
  type StopScope,
} from '@acbp/contracts';
import { StopRepository, writeAuditEvent, type DatabaseClient, type TenantScope } from '@acbp/database';
import { sql } from 'kysely';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import type { Logger } from '@acbp/observability';

export interface StopServiceOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  readonly auditWriter?: typeof writeAuditEvent;
}

/** Why a stop operation was refused. CLOSED — a reason, never an exception message. */
export const STOP_REFUSAL_REASONS = [
  'not_a_scope',
  'scope_not_enforceable',
  'target_required',
  'target_not_allowed',
  'already_active',
  'not_found',
  'not_active',
  'already_reviewed',
] as const;
export type StopRefusalReason = (typeof STOP_REFUSAL_REASONS)[number];

/**
 * Task states that represent WORK IN FLIGHT and are therefore held by a stop (CDR-072 §1-G6; OQ-14's documented
 * MVP default: *"finish the current tool call, halt before the next, hold the task visibly"*).
 *
 * `draft`/`planned` are NOT held: nothing is running, so there is nothing to hold and adding them would inflate the
 * review queue with work that never started. Terminal states are not held for the obvious reason.
 */
const IN_FLIGHT_TASK_STATES = ['queued', 'running', 'waiting_for_input', 'waiting_for_approval'] as const;

export interface ActivateStopParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /** Unvalidated on purpose — refusing a bad scope is this function's job, not the type system's. */
  readonly scope: unknown;
  readonly targetId?: string | null;
  readonly reason?: string | null;
}

export type ActivateStopResult =
  | { readonly status: 'ok'; readonly stopId: string; readonly scope: StopScope; readonly heldCount: number }
  | { readonly status: 'refused'; readonly reason: StopRefusalReason }
  | { readonly status: 'forbidden' };

/**
 * Activate an emergency stop (ADMIN-001).
 *
 * OWNER-ONLY via `stop:activate`, which is deliberately a different action from `stop:clear`: whoever may halt the
 * platform is not automatically whoever may restart it.
 */
export async function activateStop(client: DatabaseClient, params: ActivateStopParams, options: StopServiceOptions = {}): Promise<ActivateStopResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ActivateStopResult> => {
      if (checkAuthorization(role, 'stop:activate', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') {
        return { status: 'forbidden' };
      }

      // ── every refusal below happens BEFORE the first write, so a typed result is safe here (§1-G8) ──
      if (!isStopScope(params.scope)) return { status: 'refused', reason: 'not_a_scope' };
      // REFUSED BY NAME, never accepted-and-inert. See the header.
      if (!isEnforceableStopScope(params.scope)) return { status: 'refused', reason: 'scope_not_enforceable' };

      const requiresTarget = params.scope === 'task' || params.scope === 'worker' || params.scope === 'company';
      const target = typeof params.targetId === 'string' ? params.targetId.trim() : '';
      if (requiresTarget && target === '') return { status: 'refused', reason: 'target_required' };
      if (!requiresTarget && target !== '') return { status: 'refused', reason: 'target_not_allowed' };

      const stops = new StopRepository(scope.db);
      const created = await stops.insert({
        accountId: scope.tenant.accountId,
        // NULL for `account_wide` ONLY — migration 0050's CHECK is what keeps that true. An account-wide stop
        // pinned to a company would not cover its siblings, which is the silent miss wearing a schema.
        companyId: params.scope === 'account_wide' ? null : scope.tenant.companyId,
        scope: params.scope,
        targetId: requiresTarget ? target : null,
        reason: params.reason ?? null,
        activatedByUserId: params.userId,
      });
      // Still no write of ours has landed — the conflict means someone else's stop of this exact shape is already
      // active, so a typed refusal is honest and nothing needs rolling back.
      if (created === undefined) return { status: 'refused', reason: 'already_active' };

      // ── FIRST WRITE HAS LANDED. Everything below THROWS on failure (§1-G8). ──

      // Hold work that is in flight. `held_work` is company-scoped, so an account-wide stop holds the work of the
      // company it was raised from; other companies' work is held when their own scope is evaluated at dispatch.
      // Nothing is cancelled — diagram 13's queue is "visible, nothing lost".
      const inFlight = await sql<{ id: string }>`
        select id from tasks
        where company_id = ${scope.tenant.companyId}::uuid
          and state in (${sql.join(IN_FLIGHT_TASK_STATES.map((s) => sql.lit(s)))})
        order by id
      `.execute(scope.db);

      let heldCount = 0;
      for (const task of inFlight.rows) {
        const held = await stops.hold({
          accountId: scope.tenant.accountId,
          companyId: scope.tenant.companyId,
          stopId: created.id,
          taskId: task.id,
        });
        if (held !== undefined) heldCount += 1;
      }

      // The evidence names WHAT halted, not that something did (§1-G5).
      await audit(
        scope,
        emergencyStopActivated({ stopId: created.id, scope: params.scope, target: requiresTarget ? target : null, heldCount }),
        auditCtx(options),
      );
      options.logger?.warn('stop.activated', {
        metadata: { accountId: params.accountId, companyId: params.companyId, scope: params.scope, heldCount },
      });
      return { status: 'ok', stopId: created.id, scope: params.scope, heldCount };
    },
    opts(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}

export interface ClearStopParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly stopId: string;
  readonly at: Date;
}

export type ClearStopResult =
  | { readonly status: 'ok'; readonly stopId: string; readonly pendingReviewCount: number }
  | { readonly status: 'refused'; readonly reason: StopRefusalReason }
  | { readonly status: 'forbidden' };

/**
 * Clear a stop (ADMIN-002).
 *
 * CLEARING RESUMES NOTHING. Every held item still needs its own confirm-or-discard decision, and the event carries
 * `pending_review_count` so the record cannot imply the halt was simply over. *"Nothing auto-fires on resume"* is
 * the clause; a clear that silently re-ran held work would be the same betrayal as a stop that missed a scope.
 */
export async function clearStop(client: DatabaseClient, params: ClearStopParams, options: StopServiceOptions = {}): Promise<ClearStopResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ClearStopResult> => {
      if (checkAuthorization(role, 'stop:clear', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') {
        return { status: 'forbidden' };
      }

      const stops = new StopRepository(scope.db);
      const existing = await stops.findById(params.stopId);
      if (existing === undefined) return { status: 'refused', reason: 'not_found' };
      if (existing.status !== 'active') return { status: 'refused', reason: 'not_active' };

      const cleared = await stops.clear(params.stopId, params.userId, params.at);
      // Guarded on `status = 'active'`, so `undefined` means a concurrent clearer won. Nothing of ours has been
      // written, so a typed refusal is safe and honest.
      if (cleared === undefined) return { status: 'refused', reason: 'not_active' };

      const pending = await stops.listHeld(params.stopId);
      await audit(scope, emergencyStopCleared({ stopId: params.stopId, scope: existing.scope, pendingReviewCount: pending.length }), auditCtx(options));
      options.logger?.warn('stop.cleared', {
        metadata: { accountId: params.accountId, companyId: params.companyId, scope: existing.scope, pendingReviewCount: pending.length },
      });
      return { status: 'ok', stopId: params.stopId, pendingReviewCount: pending.length };
    },
    opts(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}

export interface ReviewHeldWorkParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly heldWorkId: string;
  readonly decision: 'confirmed' | 'discarded';
  readonly at: Date;
}

export type ReviewHeldWorkResult =
  | { readonly status: 'ok'; readonly heldWorkId: string }
  | { readonly status: 'refused'; readonly reason: StopRefusalReason }
  | { readonly status: 'forbidden' };

/**
 * Confirm or discard ONE held item (ADMIN-002's review-to-resume).
 *
 * Rides `stop:clear`, not a separate action: deciding that held work may run again is the same authority as lifting
 * the halt that stopped it. A DISCARD is recorded exactly as loudly as a confirm — it is a decision an operator
 * made, not the absence of one, and the row is never deleted.
 *
 * THIS FUNCTION DOES NOT RESUME ANYTHING. It records the decision. Re-queueing confirmed work belongs to the task
 * state machine, and wiring it here would make "nothing auto-fires on resume" false.
 */
export async function reviewHeldWork(client: DatabaseClient, params: ReviewHeldWorkParams, options: StopServiceOptions = {}): Promise<ReviewHeldWorkResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ReviewHeldWorkResult> => {
      if (checkAuthorization(role, 'stop:clear', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') {
        return { status: 'forbidden' };
      }

      const stops = new StopRepository(scope.db);
      const row = await sql<{ stop_id: string; status: string }>`
        select stop_id, status from held_work where id = ${params.heldWorkId}::uuid
      `.execute(scope.db);
      const held = row.rows[0];
      if (held === undefined) return { status: 'refused', reason: 'not_found' };
      if (held.status !== 'held') return { status: 'refused', reason: 'already_reviewed' };

      const reviewed = await stops.review(params.heldWorkId, params.decision, params.userId, params.at);
      // Guarded on `status = 'held'`: a concurrent reviewer already decided this item. Their decision stands —
      // silently overwriting it would make ADMIN-002's review replaceable, which is not a decision at all.
      if (reviewed === undefined) return { status: 'refused', reason: 'already_reviewed' };

      await audit(scope, emergencyStopWorkReviewed({ stopId: held.stop_id, decision: params.decision, heldWorkId: params.heldWorkId }), auditCtx(options));
      return { status: 'ok', heldWorkId: params.heldWorkId };
    },
    opts(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}

/** One scope as the read model presents it. `enforceable` is NOT decoration — see {@link readStopState}. */
export interface StopScopeAvailability {
  readonly scope: StopScope;
  readonly enforceable: boolean;
  /** Present only when the scope is inert, and states plainly that activating it is refused. */
  readonly unavailableReason?: string;
}

export type ReadStopStateResult =
  | {
      readonly status: 'ok';
      readonly activeStops: readonly { readonly stopId: string; readonly scope: string; readonly targetId: string | null; readonly activatedAt: Date }[];
      readonly scopes: readonly StopScopeAvailability[];
    }
  | { readonly status: 'forbidden' };

/**
 * What is halted, and which scopes can halt anything (`stop:read`; viewer-visible).
 *
 * **THE `scopes` LIST IS THE LOUD PART.** It returns all seven with `enforceable` set, and the two inert scopes
 * carry an explicit reason — because a surface that listed seven scopes without saying two do nothing would let an
 * operator believe a stop covers a capability or an integration. That is the nominal-vs-substantive failure this
 * ticket is built to avoid, and it would be introduced by a *read model*, of all things.
 *
 * NO UI IS SHIPPED. This returns the data a surface would need; building the surface is an owner gate.
 */
export async function readStopState(
  client: DatabaseClient,
  params: Pick<ActivateStopParams, 'userId' | 'accountId' | 'companyId'>,
  options: StopServiceOptions = {},
): Promise<ReadStopStateResult> {
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ReadStopStateResult> => {
      if (checkAuthorization(role, 'stop:read', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') {
        return { status: 'forbidden' };
      }
      const active = await new StopRepository(scope.db).listActive();
      return {
        status: 'ok',
        activeStops: active.map((s) => ({ stopId: s.id, scope: s.scope, targetId: s.target_id, activatedAt: s.activated_at })),
        scopes: STOP_SCOPES.map((s) => ({
          scope: s,
          enforceable: ENFORCEABLE_STOP_SCOPES.includes(s),
          ...(NOT_YET_ENFORCEABLE_STOP_SCOPES.includes(s)
            ? { unavailableReason: 'Not enforceable in this release: the tool registry carries no identity for it, so activation is refused.' }
            : {}),
        })),
      };
    },
    opts(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}

function opts(options: StopServiceOptions): { correlationId?: string; logger?: Logger } {
  return { ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }), ...(options.logger === undefined ? {} : { logger: options.logger }) };
}

function auditCtx(options: StopServiceOptions): { correlationId?: string } {
  return options.correlationId === undefined ? {} : { correlationId: options.correlationId };
}

export type { TenantScope };
