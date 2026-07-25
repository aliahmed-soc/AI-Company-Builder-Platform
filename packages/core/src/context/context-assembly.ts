// @acbp/core — context assembly use case (ACBP-P2-007; CDR-032; AI-AND-WORKER §1; MEM-004; NFR-018/021; invariant 12).
//
// Builds the model context from the company's typed memory: read the current memory (its own memory:read scope) →
// PROVENANCE-RANK it (confirmed user > accepted assumptions > research; invalidated excluded) → detect MEM-004
// conflicts (a confirmed user item + an AI assumption on the same `source_ref`) and HOLD both out of the context,
// surfacing them as an open question (never silently rank-resolved) → REDACT secrets from each item's content (the
// reviewed fail-closed blocklist — invariant 12) → return the assembled `contextParts` + the conflicts. A flagged
// conflict is AUDITED in the SAME transaction (`context.conflict_flagged`, BACKLOG "Conflict events audited"). NO
// model call — assembly builds the model's PROMPT; calling the model here would be circular (the deferred live
// provider is CDR-026 §0). Conflict DETECTION is the deterministic same-source_ref/provenance signal; arbitrary
// semantic contradiction needs the model (P2-005) and is deferred (CDR-032 §3).
import { MemoryItemRepository, writeAuditEvent, type DatabaseClient, type AuditScope, type AuditWriteContext } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import {
  rankMemoryForContext,
  detectMemoryConflicts,
  conflictedItemIds,
  redactSecrets,
  contextConflictFlagged,
  type AuditEvent,
  type MemoryType,
  type MemoryConfirmationState,
  type MemoryConflict,
  type ModelContextPart,
} from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

type AuditWriteFn = (scope: AuditScope, event: AuditEvent, ctx?: AuditWriteContext) => Promise<string>;

/** Bounded number of memory items pulled into a single assembly. */
export const MAX_CONTEXT_ITEMS = 200;

export interface AssembleContextParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}
export interface AssembleContextOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  /** Bounded item cap (default {@link MAX_CONTEXT_ITEMS}). */
  readonly limit?: number;
  /** TEST SEAM ONLY: override the in-tx audit writer to force a failure (prove nothing is surfaced). */
  readonly auditWriter?: AuditWriteFn;
}

/** A surfaced MEM-004 conflict (the caller turns it into an open question for the founder). */
export interface AssembledConflict {
  readonly sourceRef: string;
  readonly confirmedItemIds: readonly string[];
  readonly assumptionItemIds: readonly string[];
}

export type AssembleContextResult =
  | { readonly status: 'ok'; readonly contextParts: readonly ModelContextPart[]; readonly conflicts: readonly AssembledConflict[] }
  | { readonly status: 'forbidden' };

function clampLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MAX_CONTEXT_ITEMS;
  const n = Math.floor(value);
  if (n < 1) return 1;
  if (n > MAX_CONTEXT_ITEMS) return MAX_CONTEXT_ITEMS;
  return n;
}

function toConflictDTO(c: MemoryConflict): AssembledConflict {
  return { sourceRef: c.sourceRef, confirmedItemIds: c.confirmedItemIds, assumptionItemIds: c.assumptionItemIds };
}

/**
 * Assemble the provenance-ranked, secret-redacted, conflict-safe model context from the company's typed memory.
 * Owner+viewer (`memory:read`), company-scoped, dual-keyed RLS. Returns the ordered `contextParts` (conflicting items
 * withheld) plus the surfaced conflicts. Each conflict is audited in-tx (audit-or-nothing: an audit-write failure
 * surfaces nothing).
 */
export async function assembleContext(client: DatabaseClient, params: AssembleContextParams, options: AssembleContextOptions = {}): Promise<AssembleContextResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const optsBase = { ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}), ...(options.logger !== undefined ? { logger: options.logger } : {}) };
  const auditCtx: AuditWriteContext = options.correlationId !== undefined ? { correlationId: options.correlationId } : {};

  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<AssembleContextResult> => {
      if (checkAuthorization(role, 'memory:read', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { status: 'forbidden' };

      const rows = await new MemoryItemRepository(scope.db).list({ currentOnly: true, limit: clampLimit(options.limit) });

      // MEM-004 conflicts: a confirmed user item + an AI assumption on the same source_ref (deterministic, model-free).
      const conflicts = detectMemoryConflicts(rows.map((r) => ({ id: r.id, type: r.type as MemoryType, confirmationState: r.confirmation_state as MemoryConfirmationState, sourceRef: r.source_ref })));
      const withheld = conflictedItemIds(conflicts);

      // Rank the NON-conflicting items (a conflict is surfaced, never silently rank-resolved), then redact secrets.
      const ranked = rankMemoryForContext(
        rows
          .filter((r) => !withheld.has(r.id))
          .map((r) => ({ type: r.type as MemoryType, content: r.content, confidence: r.confidence ?? 0, confirmationState: r.confirmation_state as MemoryConfirmationState, createdAt: new Date(r.created_at).toISOString() })),
      );
      const contextParts: ModelContextPart[] = ranked.map((i) => ({ role: 'system', content: redactSecrets(i.content) }));

      // Each conflict is audited in the SAME transaction (audit-or-nothing) — BACKLOG "Conflict events audited".
      for (const c of conflicts) {
        await audit(scope, contextConflictFlagged({ itemId: c.confirmedItemIds[0]!, confirmedCount: c.confirmedItemIds.length, assumptionCount: c.assumptionItemIds.length }), auditCtx);
      }
      if (conflicts.length > 0) options.logger?.info('context.conflict_flagged', { metadata: { accountId: params.accountId, companyId: params.companyId, conflictCount: conflicts.length } });

      return { status: 'ok', contextParts, conflicts: conflicts.map(toConflictDTO) };
    },
    optsBase,
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
