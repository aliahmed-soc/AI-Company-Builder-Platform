// @acbp/core — typed memory item use cases (ACBP-P2-006; CDR-024; MEM-001/MEM-003).
//
// The typed memory persistence layer. Every op runs under the caller's validated CompanyScope
// (runInCompanyScope) on the restricted acbp_app role: the caller's ACTIVE company-membership role is resolved
// first, the ADR-022 role check gates the action (memory:write for create and memory:read for list/get — any
// active company member; memory:edit for the supersede and memory:delete for the soft delete — OWNER-only), and
// the mutation runs RLS-confined to the company (cross-company reads are impossible — MEM-003 trust-critical).
//
// P2-006 shipped CREATE + LIST; P2-010 added GET, EDIT (`editMemoryItem` — the owner-only versioned supersede) and
// soft DELETE (`deleteMemoryItem`, owner-only). Advancing confirmation_state (confirm) is still M3. The type is set
// by the SOURCE PATH, not by content: a generated source can never produce a `user_fact`/`user_preference`
// (contract + DB CHECK, defense in depth). A memory item creation is AUDITED (MEM-003 "All changes audited") — the
// `memory.item_created` event is written in the SAME transaction as the insert, so an audit-write failure rolls
// the item back (no unaudited memory). Audit metadata is EXACTLY `{item_type, source_type}` — never content or
// the raw source_ref.
import { MemoryItemRepository, writeAuditEvent, type DatabaseClient, type AuditScope, type AuditWriteContext, type MemoryItemRow } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import {
  validateMemorySubmission,
  memoryItemCreated,
  memoryItemSuperseded,
  memoryItemDeleted,
  isMemoryType,
  isMemorySourceType,
  type AuditEvent,
  type MemoryItemDTO,
  type MemoryConfirmationState,
  type MemoryType,
  type MemorySourceType,
  type PublicErrorEnvelope,
} from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

type AuditWriteFn = (scope: AuditScope, event: AuditEvent, ctx?: AuditWriteContext) => Promise<string>;

/** Default and hard-max page size for `listMemoryItems` (bounded — never an unbounded list). */
export const MEMORY_LIST_DEFAULT_LIMIT = 100;
export const MEMORY_LIST_MAX_LIMIT = 500;

export interface CreateMemoryItemParams {
  /** Server-verified internal user id (NEVER a browser claim). */
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly type: unknown;
  readonly content: unknown;
  readonly sourceType: unknown;
  readonly sourceRef: unknown;
  readonly confidence?: unknown;
}
export interface ListMemoryItemsParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /** Optional single-type filter (invalid values are ignored → no filter). */
  readonly type?: unknown;
  /** When true, only live (not-yet-superseded) items are returned — the browser's default view. */
  readonly currentOnly?: boolean;
  /** Requested page size; clamped to [1, MEMORY_LIST_MAX_LIMIT]. */
  readonly limit?: unknown;
}
export interface EditMemoryItemParams {
  /** Server-verified internal user id (NEVER a browser claim). */
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /** The CURRENT memory item to correct (must not already be superseded). */
  readonly targetId: string;
  readonly type: unknown;
  readonly content: unknown;
  readonly confidence?: unknown;
}
export interface GetMemoryItemParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly memoryItemId: string;
}
export interface DeleteMemoryItemParams {
  /** Server-verified internal user id (NEVER a browser claim). */
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly memoryItemId: string;
}
export interface MemoryOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  /** TEST SEAM ONLY: override the in-tx audit writer to force a failure (prove create rolls back). */
  readonly auditWriter?: AuditWriteFn;
}

export type CreateMemoryItemResult = { readonly status: 'ok'; readonly item: MemoryItemDTO } | { readonly status: 'forbidden' } | { readonly status: 'validation'; readonly error: PublicErrorEnvelope };
export type ListMemoryItemsResult = { readonly status: 'ok'; readonly items: readonly MemoryItemDTO[] } | { readonly status: 'forbidden' };
export type EditMemoryItemResult =
  | { readonly status: 'ok'; readonly item: MemoryItemDTO }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'conflict' }
  | { readonly status: 'validation'; readonly error: PublicErrorEnvelope };
export type GetMemoryItemResult = { readonly status: 'ok'; readonly item: MemoryItemDTO } | { readonly status: 'forbidden' } | { readonly status: 'not_found' };
export type DeleteMemoryItemResult =
  | { readonly status: 'ok'; readonly memoryItemId: string }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'conflict' };

// ── create (audited in-transaction) ────────────────────────────────────────────────────────────────────
export async function createMemoryItem(client: DatabaseClient, params: CreateMemoryItemParams, options: MemoryOptions = {}): Promise<CreateMemoryItemResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<CreateMemoryItemResult> => {
      if (checkAuthorization(role, 'memory:write', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') return { status: 'forbidden' };
      // The type is validated AND proven consistent with the source path (a generated claim can never be a
      // user_fact); untyped/unknown-source/over-long content/empty-or-over-long source_ref submissions are
      // rejected — bounded error. (source_ref is enforced non-empty + bounded; deep resolvability is P2-007.)
      const submission = validateMemorySubmission({ type: params.type, content: params.content, sourceType: params.sourceType, sourceRef: params.sourceRef, confidence: params.confidence });
      if (!submission.ok) return { status: 'validation', error: submission.error };

      const repo = new MemoryItemRepository(scope.db);
      const row = await repo.insert({
        accountId: params.accountId,
        companyId: params.companyId,
        type: submission.value.type,
        content: submission.value.content,
        sourceType: submission.value.sourceType,
        sourceRef: submission.value.sourceRef,
        confidence: submission.value.confidence,
        createdByUserId: params.userId,
      });
      // memory.item_created in the SAME transaction — a write failure rolls the item back (no unaudited memory).
      // Metadata is EXACTLY {item_type, source_type}; the actor/account/company are stamped server-side.
      await audit(scope, memoryItemCreated({ memoryItemId: row.id, itemType: row.type, sourceType: row.source_type }), auditContext(options));
      options.logger?.info('memory.item_created', { metadata: { accountId: params.accountId, companyId: params.companyId, itemType: row.type, sourceType: row.source_type } });
      return { status: 'ok', item: toDTO(row) };
    },
    optionsFor(options),
  );
  return unwrap(run);
}

// ── list ───────────────────────────────────────────────────────────────────────────────────────────────
export async function listMemoryItems(client: DatabaseClient, params: ListMemoryItemsParams, options: MemoryOptions = {}): Promise<ListMemoryItemsResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ListMemoryItemsResult> => {
      if (checkAuthorization(role, 'memory:read', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') return { status: 'forbidden' };
      const typeFilter = isMemoryType(params.type) ? params.type : undefined;
      const limit = clampLimit(params.limit);
      const opts: { type?: MemoryType; currentOnly?: boolean; limit: number } = { limit };
      if (typeFilter !== undefined) opts.type = typeFilter;
      if (params.currentOnly === true) opts.currentOnly = true;
      const rows = await new MemoryItemRepository(scope.db).list(opts);
      return { status: 'ok', items: rows.map(toDTO) };
    },
    optionsFor(options),
  );
  return unwrap(run);
}

// ── edit = versioned supersede (owner-only; audited in-tx) ─────────────────────────────────────────────
/**
 * Correct a memory item by SUPERSEDING it (never overwrite — DATA-ARCHITECTURE §3). Inserts a NEW `user_edit`
 * version (whose `source_ref` cites the corrected item) and points the OLD row's `superseded_by` at it, guarded
 * so only the CURRENT (not-yet-superseded) row can be edited. `memory.item_superseded` is written in the SAME
 * transaction, so an audit failure rolls the whole edit back. Owner-only (`memory:edit`).
 */
export async function editMemoryItem(client: DatabaseClient, params: EditMemoryItemParams, options: MemoryOptions = {}): Promise<EditMemoryItemResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<EditMemoryItemResult> => {
      if (checkAuthorization(role, 'memory:edit', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') return { status: 'forbidden' };
      // The correction is a user_edit whose source_ref is the item it corrects; type-by-source-path lets a
      // user_edit carry any of the 8 types.
      const submission = validateMemorySubmission({ type: params.type, content: params.content, sourceType: 'user_edit', sourceRef: params.targetId, confidence: params.confidence });
      if (!submission.ok) return { status: 'validation', error: submission.error };

      const repo = new MemoryItemRepository(scope.db);
      // Lock the target row FOR UPDATE so concurrent edits serialize: the loser blocks, then re-reads the
      // now-superseded row and conflicts HERE — before inserting anything — so no orphaned new version is ever
      // committed (the insert-then-supersede ordering is made race-safe by the lock).
      const target = await repo.findByIdForUpdate(params.targetId);
      if (target === undefined) return { status: 'not_found' };
      // Only the CURRENT active version is editable — a superseded historical version or a deleted item cannot be
      // edited (its state conflicts with the operation).
      if (target.superseded_by !== null || target.deleted_at !== null) return { status: 'conflict' };

      const created = await repo.insert({
        accountId: params.accountId,
        companyId: params.companyId,
        type: submission.value.type,
        content: submission.value.content,
        sourceType: submission.value.sourceType,
        sourceRef: submission.value.sourceRef,
        confidence: submission.value.confidence,
        createdByUserId: params.userId,
      });
      const updated = await repo.supersede(params.targetId, created.id);
      if (updated === 0) return { status: 'conflict' }; // raced: the target was superseded between load and update
      await audit(scope, memoryItemSuperseded({ supersededItemId: params.targetId, newItemType: created.type, newSourceType: created.source_type }), auditContext(options));
      options.logger?.info('memory.item_superseded', { metadata: { accountId: params.accountId, companyId: params.companyId, itemType: created.type } });
      return { status: 'ok', item: toDTO(created) };
    },
    optionsFor(options),
  );
  return unwrapExtended(run);
}

// ── get a single item ──────────────────────────────────────────────────────────────────────────────────
export async function getMemoryItem(client: DatabaseClient, params: GetMemoryItemParams, options: MemoryOptions = {}): Promise<GetMemoryItemResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<GetMemoryItemResult> => {
      if (checkAuthorization(role, 'memory:read', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') return { status: 'forbidden' };
      const row = await new MemoryItemRepository(scope.db).findById(params.memoryItemId);
      // Deleted items are omitted from the browser (CDR-025 §6) — a deleted item reads as not_found.
      if (row === undefined || row.deleted_at !== null) return { status: 'not_found' };
      return { status: 'ok', item: toDTO(row) };
    },
    optionsFor(options),
  );
  return unwrapExtended(run);
}

// ── delete = soft delete (owner-only; audited in-tx) ───────────────────────────────────────────────────
/**
 * Soft-delete a CURRENT active memory item (CDR-025 §0; owner-only `memory:delete`). Sets `deleted_at` (server
 * clock) + `deleted_by_user_id`, guarded so only an active item transitions (a superseded/already-deleted item →
 * bounded `conflict`; a concurrent delete loses the guard → `conflict`, so exactly one transition + one audit).
 * `memory.item_deleted` is written in the SAME transaction (audit-or-nothing — a failure leaves the row live and
 * no audit row). No content overwrite, no hard delete, no dependent propagation (CDR-025 §7, deferred to M3/M4).
 */
export async function deleteMemoryItem(client: DatabaseClient, params: DeleteMemoryItemParams, options: MemoryOptions = {}): Promise<DeleteMemoryItemResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<DeleteMemoryItemResult> => {
      if (checkAuthorization(role, 'memory:delete', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') return { status: 'forbidden' };
      const repo = new MemoryItemRepository(scope.db);
      const target = await repo.findById(params.memoryItemId);
      if (target === undefined) return { status: 'not_found' };
      // Delete is permitted only for a current active item; a superseded historical version or an already-deleted
      // item cannot be deleted (bounded conflict — no re-delete, no deleting history).
      if (target.superseded_by !== null || target.deleted_at !== null) return { status: 'conflict' };

      const updated = await repo.softDelete(params.memoryItemId, params.userId);
      if (updated === 0) return { status: 'conflict' }; // raced: a concurrent delete/supersede moved it first
      // memory.item_deleted in the SAME transaction — an audit failure rolls the delete back (row stays live).
      await audit(scope, memoryItemDeleted({ memoryItemId: params.memoryItemId, itemType: target.type, sourceType: target.source_type }), auditContext(options));
      options.logger?.info('memory.item_deleted', { metadata: { accountId: params.accountId, companyId: params.companyId, itemType: target.type, sourceType: target.source_type } });
      return { status: 'ok', memoryItemId: params.memoryItemId };
    },
    optionsFor(options),
  );
  return unwrapExtended(run);
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────
/** Like `unwrap`, but preserves the richer result unions (not_found/conflict) instead of collapsing to ok|forbidden. */
function unwrapExtended<T extends { status: string }>(run: { kind: 'ran'; value: T } | { kind: 'denied'; reason: string }): T | { status: 'forbidden' } {
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MEMORY_LIST_DEFAULT_LIMIT;
  const n = Math.floor(value);
  if (n < 1) return 1;
  if (n > MEMORY_LIST_MAX_LIMIT) return MEMORY_LIST_MAX_LIMIT;
  return n;
}
function auditContext(options: MemoryOptions): AuditWriteContext {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}
function optionsFor(options: MemoryOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}
/** Redacted DTO (CDR-024 §3): no accountId, no created_by_user_id, no actor. The CHECKs guarantee valid enums. */
function toDTO(row: MemoryItemRow): MemoryItemDTO {
  return {
    memoryItemId: row.id,
    type: assertType(row.type),
    content: row.content,
    sourceType: assertSourceType(row.source_type),
    sourceRef: row.source_ref,
    confidence: row.confidence,
    confirmationState: row.confirmation_state as MemoryConfirmationState,
    supersededBy: row.superseded_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
// The DB CHECKs guarantee `type`/`source_type` are always in-set, so these are can't-happen paths. If one ever
// fired it would mean row corruption — for a TRUST-CRITICAL field we FAIL CLOSED (throw) rather than silently
// relabel an unknown value as the most-trusted `user_fact`/`user_edit` (security review LOW). The throw is
// unreachable in practice; it never serves a corrupt row as if it were a founder-stated fact.
function assertType(value: string): MemoryType {
  if (!isMemoryType(value)) throw new Error('memory item invariant: type is out of the closed set (row corruption)');
  return value;
}
function assertSourceType(value: string): MemorySourceType {
  if (!isMemorySourceType(value)) throw new Error('memory item invariant: source_type is out of the closed set (row corruption)');
  return value;
}
function unwrap<T extends { status: string }>(run: { kind: 'ran'; value: T } | { kind: 'denied'; reason: string }): T | { status: 'forbidden' } {
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
