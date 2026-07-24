// @acbp/core — understanding review + confirmation use cases (ACBP-P2-009; CDR-030; UNDER-003/004, DISC-008).
//
// The owner's review + confirmation gate over an immutable, versioned understanding document (P2-008). Four use
// cases, each run in a FRESH company scope (server-resolved account/company/actor; owner-only authz; dual-keyed RLS):
//   - recordUnderstandingReview — one of the five per-item controls (approve/edit/reject/request-evidence/
//     request-research), append-only + audited in-tx (understanding.item_reviewed);
//   - confirmUnderstanding — the owner-only confirm that unlocks strategy (understanding.confirmed, audited in-tx),
//     idempotent via the UNIQUE(document_id,'confirmed') event;
//   - correctUnderstanding — the DISC-008 material correction that supersedes a confirmation and flags dependents
//     (understanding.corrected, audited in-tx), idempotent;
//   - isCurrentUnderstandingConfirmed — the strategy-unlock GATE predicate (owner+viewer read).
// No model call is made (BACKLOG Usage = "—"); evidence/research requests are RECORDED, not executed. Audit-or-nothing:
// each write + its audit event are one transaction. No content or PII in any audit metadata.
import {
  UnderstandingRepository,
  UnderstandingReviewRepository,
  writeAuditEvent,
  type DatabaseClient,
  type AuditScope,
  type AuditWriteContext,
} from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import {
  understandingItemReviewed,
  understandingConfirmed,
  understandingCorrected,
  isReviewDecision,
  isConfirmationEventKind,
  isExpectedVersionCurrent,
  isVersionConfirmed,
  validateReviewNote,
  CORRECTION_REF_MAX,
  type AuditEvent,
  type ReviewDecision,
} from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

type AuditWriteFn = (scope: AuditScope, event: AuditEvent, ctx?: AuditWriteContext) => Promise<string>;

/**
 * MVP dependents flagged by a correction: the single downstream strategy stage (P3-001) whose unlock is revoked. When
 * strategy options become real rows, this becomes the count of invalidated options (CDR-030 §4). Kept a named constant
 * so the honest meaning is explicit and the audit metadata is deterministic.
 */
export const STRATEGY_DEPENDENT_COUNT = 1;

export interface UnderstandingReviewOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  /** TEST SEAM ONLY: override the in-tx audit writer to force a failure (prove the write rolls back). */
  readonly auditWriter?: AuditWriteFn;
}

// ── Review a single item ─────────────────────────────────────────────────────────────────────────────────
export interface RecordReviewParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly itemId: string;
  readonly decision: string;
  readonly note?: string | null;
  /** The understanding version the owner is reviewing (optimistic concurrency; must equal the current version). */
  readonly expectedVersion: number;
}
export interface UnderstandingReviewDTO {
  readonly reviewId: string;
  readonly itemId: string;
  readonly decision: ReviewDecision;
  readonly note: string | null;
  readonly version: number;
  readonly createdAt: string;
}
export type RecordReviewResult =
  | { readonly status: 'ok'; readonly review: UnderstandingReviewDTO }
  | { readonly status: 'forbidden' }
  | { readonly status: 'no_understanding' }
  | { readonly status: 'stale_version' }
  | { readonly status: 'item_not_found' }
  | { readonly status: 'invalid' };

/**
 * Record one owner review decision on an item of the CURRENT understanding version. Owner-only. Rejects a decision
 * outside the closed five-control set, a note that fails validation (`edited` requires a bounded note; the rest
 * optional), a stale `expected_version`, or an item that is absent / not part of the current version. Append-only —
 * the item's effective review state is its latest row. `understanding.item_reviewed` is written in the SAME
 * transaction (audit-or-nothing).
 */
export async function recordUnderstandingReview(client: DatabaseClient, params: RecordReviewParams, options: UnderstandingReviewOptions = {}): Promise<RecordReviewResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<RecordReviewResult> => {
      if (checkAuthorization(role, 'understanding:review', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      if (!isReviewDecision(params.decision)) return { status: 'invalid' };
      const noteCheck = validateReviewNote(params.decision, params.note ?? null);
      if (!noteCheck.ok) return { status: 'invalid' };

      const docs = new UnderstandingRepository(scope.db);
      const current = await docs.currentDocument(params.companyId);
      if (current === undefined) return { status: 'no_understanding' };
      if (!isExpectedVersionCurrent(params.expectedVersion, current.version)) return { status: 'stale_version' };
      // The item must exist AND belong to the CURRENT version — a review never targets a superseded version's item.
      const item = await docs.findItem(params.itemId);
      if (item === undefined || item.document_id !== current.id) return { status: 'item_not_found' };

      const reviews = new UnderstandingReviewRepository(scope.db);
      const row = await reviews.insertReview({
        accountId: params.accountId,
        companyId: params.companyId,
        documentId: current.id,
        itemId: params.itemId,
        decision: params.decision,
        note: noteCheck.note,
        decidedByUserId: params.userId,
      });
      await audit(scope, understandingItemReviewed({ itemId: params.itemId, decision: params.decision, version: current.version }), auditCtx(options));
      options.logger?.info('understanding.item_reviewed', { metadata: { accountId: params.accountId, companyId: params.companyId, version: current.version, decision: params.decision } });
      return { status: 'ok', review: { reviewId: row.id, itemId: params.itemId, decision: params.decision, note: noteCheck.note, version: current.version, createdAt: new Date(row.created_at).toISOString() } };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── Confirm the current understanding version (the strategy gate) ────────────────────────────────────────
export interface ConfirmParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly expectedVersion: number;
}
export type ConfirmResult =
  | { readonly status: 'ok'; readonly version: number; readonly alreadyConfirmed: boolean }
  | { readonly status: 'forbidden' }
  | { readonly status: 'no_understanding' }
  | { readonly status: 'stale_version' };

/**
 * Owner-only confirm of the CURRENT understanding version (`ready_for_review → confirmed`; WORKFLOW §2). Unlocks
 * strategy. Rejects a stale `expected_version` or a version already superseded by a correction. Idempotent: a repeat
 * confirm of an already-confirmed version is a graceful no-op success (no second audit). `understanding.confirmed`
 * is written in the SAME transaction (audit-or-nothing).
 */
export async function confirmUnderstanding(client: DatabaseClient, params: ConfirmParams, options: UnderstandingReviewOptions = {}): Promise<ConfirmResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ConfirmResult> => {
      if (checkAuthorization(role, 'understanding:confirm', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const docs = new UnderstandingRepository(scope.db);
      const current = await docs.currentDocument(params.companyId);
      if (current === undefined) return { status: 'no_understanding' };
      if (!isExpectedVersionCurrent(params.expectedVersion, current.version)) return { status: 'stale_version' };

      const reviews = new UnderstandingReviewRepository(scope.db);
      const events = await reviews.listConfirmationEvents(current.id);
      // A version already superseded by a correction cannot be re-confirmed — regenerate a new version instead.
      if (events.some((e) => e.kind === 'corrected')) return { status: 'stale_version' };

      const inserted = await reviews.insertConfirmationEvent({
        accountId: params.accountId,
        companyId: params.companyId,
        documentId: current.id,
        version: current.version,
        kind: 'confirmed',
        actorUserId: params.userId,
        correctionRef: null,
        dependentsFlagged: null,
      });
      if (inserted === undefined) return { status: 'ok', version: current.version, alreadyConfirmed: true }; // idempotent
      await audit(scope, understandingConfirmed({ documentId: current.id, version: current.version }), auditCtx(options));
      options.logger?.info('understanding.confirmed', { metadata: { accountId: params.accountId, companyId: params.companyId, version: current.version } });
      return { status: 'ok', version: current.version, alreadyConfirmed: false };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── Correct (supersede) a confirmed understanding version — DISC-008 ─────────────────────────────────────
export interface CorrectParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly expectedVersion: number;
  /** A bounded reference to what was corrected (an item id / short code — never content). */
  readonly correctionRef: string;
}
export type CorrectResult =
  | { readonly status: 'ok'; readonly version: number; readonly dependentsFlagged: number; readonly alreadyCorrected: boolean }
  | { readonly status: 'forbidden' }
  | { readonly status: 'no_understanding' }
  | { readonly status: 'stale_version' }
  | { readonly status: 'not_confirmed' }
  | { readonly status: 'invalid' };

/**
 * Owner-only material correction of a CONFIRMED understanding version (`confirmed → superseded`; DISC-008). Supersedes
 * the confirmation (the strategy-unlock predicate flips back to false — dependents flagged) and records
 * `understanding.corrected` in the SAME transaction (audit-or-nothing). Rejects a stale `expected_version`, a version
 * that was never confirmed, or an invalid `correction_ref`. Idempotent: a repeat correction is a graceful no-op.
 */
export async function correctUnderstanding(client: DatabaseClient, params: CorrectParams, options: UnderstandingReviewOptions = {}): Promise<CorrectResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<CorrectResult> => {
      if (checkAuthorization(role, 'understanding:review', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const ref = params.correctionRef.trim();
      if (ref.length === 0 || ref.length > CORRECTION_REF_MAX) return { status: 'invalid' };

      const docs = new UnderstandingRepository(scope.db);
      const current = await docs.currentDocument(params.companyId);
      if (current === undefined) return { status: 'no_understanding' };
      if (!isExpectedVersionCurrent(params.expectedVersion, current.version)) return { status: 'stale_version' };

      const reviews = new UnderstandingReviewRepository(scope.db);
      const events = await reviews.listConfirmationEvents(current.id);
      // A correction supersedes a CONFIRMATION — there must be a confirmed version to correct (else nothing to flag).
      if (!events.some((e) => e.kind === 'confirmed')) return { status: 'not_confirmed' };
      if (events.some((e) => e.kind === 'corrected')) return { status: 'ok', version: current.version, dependentsFlagged: STRATEGY_DEPENDENT_COUNT, alreadyCorrected: true }; // idempotent

      const inserted = await reviews.insertConfirmationEvent({
        accountId: params.accountId,
        companyId: params.companyId,
        documentId: current.id,
        version: current.version,
        kind: 'corrected',
        actorUserId: params.userId,
        correctionRef: ref,
        dependentsFlagged: STRATEGY_DEPENDENT_COUNT,
      });
      if (inserted === undefined) return { status: 'ok', version: current.version, dependentsFlagged: STRATEGY_DEPENDENT_COUNT, alreadyCorrected: true }; // raced: already corrected
      await audit(scope, understandingCorrected({ documentId: current.id, version: current.version, correctionRef: ref, dependentsFlagged: STRATEGY_DEPENDENT_COUNT }), auditCtx(options));
      options.logger?.info('understanding.corrected', { metadata: { accountId: params.accountId, companyId: params.companyId, version: current.version, dependentsFlagged: STRATEGY_DEPENDENT_COUNT } });
      return { status: 'ok', version: current.version, dependentsFlagged: STRATEGY_DEPENDENT_COUNT, alreadyCorrected: false };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── The strategy-unlock gate predicate ───────────────────────────────────────────────────────────────────
export interface GateParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}
export type GateResult =
  | { readonly status: 'ok'; readonly confirmed: boolean; readonly version: number | null }
  | { readonly status: 'forbidden' };

/**
 * The strategy-unlock gate (WORKFLOW §2; UNDER-003 "planning blocked until confirm"). Read-only (owner+viewer).
 * Returns `confirmed = true` IFF the company's CURRENT understanding version has a `confirmed` and no `corrected`
 * event. No understanding yet → `confirmed = false, version = null`. Strategy generation (P3-001) consults this.
 */
export async function isCurrentUnderstandingConfirmed(client: DatabaseClient, params: GateParams, options: UnderstandingReviewOptions = {}): Promise<GateResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<GateResult> => {
      if (checkAuthorization(role, 'understanding:read', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const current = await new UnderstandingRepository(scope.db).currentDocument(params.companyId);
      if (current === undefined) return { status: 'ok', confirmed: false, version: null };
      const events = await new UnderstandingReviewRepository(scope.db).listConfirmationEvents(current.id);
      // Defensive: the DB CHECK guarantees kinds are in-set; the pure predicate filters to the known kinds.
      return { status: 'ok', confirmed: isVersionConfirmed(events.filter((e) => isConfirmationEventKind(e.kind)).map((e) => ({ kind: e.kind as 'confirmed' | 'corrected' }))), version: current.version };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────
function auditCtx(options: UnderstandingReviewOptions): AuditWriteContext {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}
function opts(options: UnderstandingReviewOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}
