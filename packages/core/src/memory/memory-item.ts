// @acbp/core — typed memory item use cases (ACBP-P2-006; CDR-024; MEM-001/MEM-003).
//
// The typed memory persistence layer. Every op runs under the caller's validated CompanyScope
// (runInCompanyScope) on the restricted acbp_app role: the caller's ACTIVE company-membership role is resolved
// first, the ADR-022 role check gates the action (memory:write for create, memory:read for list — any active
// company member), and the mutation runs RLS-confined to the company (cross-company reads are impossible —
// MEM-003 trust-critical).
//
// P2-006 implements CREATE + LIST only (supersede/confirm/delete are P2-010/M3). The type is set by the SOURCE
// PATH, not by content: a generated source can never produce a `user_fact`/`user_preference` (contract +
// DB CHECK, defense in depth). A memory item creation is AUDITED (MEM-003 "All changes audited") — the
// `memory.item_created` event is written in the SAME transaction as the insert, so an audit-write failure rolls
// the item back (no unaudited memory). Audit metadata is EXACTLY `{item_type, source_type}` — never content or
// the raw source_ref.
import { MemoryItemRepository, writeAuditEvent, type DatabaseClient, type AuditScope, type AuditWriteContext, type MemoryItemRow } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import {
  validateMemorySubmission,
  memoryItemCreated,
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
  /** Requested page size; clamped to [1, MEMORY_LIST_MAX_LIMIT]. */
  readonly limit?: unknown;
}
export interface MemoryOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  /** TEST SEAM ONLY: override the in-tx audit writer to force a failure (prove create rolls back). */
  readonly auditWriter?: AuditWriteFn;
}

export type CreateMemoryItemResult = { readonly status: 'ok'; readonly item: MemoryItemDTO } | { readonly status: 'forbidden' } | { readonly status: 'validation'; readonly error: PublicErrorEnvelope };
export type ListMemoryItemsResult = { readonly status: 'ok'; readonly items: readonly MemoryItemDTO[] } | { readonly status: 'forbidden' };

// ── create (audited in-transaction) ────────────────────────────────────────────────────────────────────
export async function createMemoryItem(client: DatabaseClient, params: CreateMemoryItemParams, options: MemoryOptions = {}): Promise<CreateMemoryItemResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<CreateMemoryItemResult> => {
      if (checkAuthorization(role, 'memory:write', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') return { status: 'forbidden' };
      // The type is validated AND proven consistent with the source path (a generated claim can never be a
      // user_fact); untyped/unknown-source/over-long/missing-source_ref submissions are rejected — bounded error.
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
      const rows = await new MemoryItemRepository(scope.db).list(typeFilter !== undefined ? { type: typeFilter, limit } : { limit });
      return { status: 'ok', items: rows.map(toDTO) };
    },
    optionsFor(options),
  );
  return unwrap(run);
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────
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
/** The DB CHECKs guarantee valid values; coerce defensively (an out-of-set value would be data corruption). */
function assertType(value: string): MemoryType {
  return isMemoryType(value) ? value : 'user_fact';
}
function assertSourceType(value: string): MemorySourceType {
  return isMemorySourceType(value) ? value : 'user_edit';
}
function unwrap<T extends { status: string }>(run: { kind: 'ran'; value: T } | { kind: 'denied'; reason: string }): T | { status: 'forbidden' } {
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
