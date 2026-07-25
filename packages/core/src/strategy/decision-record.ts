// @acbp/core — immutable decision records (ACBP-P3-005; CDR-038; STRAT-006; ADR-015).
//
// Write the durable, audit-grade record of an owner decision: "Every strategy selection/edit/rejection creates a
// durable decision record linking inputs, options considered, and rationale" (STRAT-006). The record links the
// CONFIRMED understanding version, the options CONSIDERED (via the generation — whose option set is itself immutable),
// the SELECTION it hardens (P3-004), and an OPTIONAL owner-supplied rationale.
//
// The load-bearing guarantee is STRAT-006's failure mode — "failed record writes block the transition (decision is not
// silently unrecorded)": the decision row and its `decision.recorded` audit event are written in ONE company-scoped
// transaction (audit-or-nothing). If either fails, nothing persists, no decision exists, and the downstream planning
// gate (P4-001, which reads for a decision) cannot pass.
//
// Owner-only (`decision:record`; J-08 "Actor: owner" — the strategy:select precedent). NO model call, no metering, no
// external resource — pure persistence + audit. Recording a decision unlocks NO planning (that gate is P4-001) and
// mutates nothing: the understanding, the selection and the options all remain immutable.
import { StrategyRepository, writeAuditEvent, type DatabaseClient, type AuditScope, type AuditWriteContext, type DecisionRow } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import { decisionRecorded, normalizeDecisionRationale, type AuditEvent, type DecisionDTO } from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

type AuditWriteFn = (scope: AuditScope, event: AuditEvent, ctx?: AuditWriteContext) => Promise<string>;

export interface RecordDecisionParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly generationId: string;
  /** The recorded selection (P3-004) this decision hardens. Must belong to `generationId`. */
  readonly selectionId: string;
  /** The owner's "why". OPTIONAL — a missing rationale never blocks the record (CDR-038 §6-G2). */
  readonly rationale?: unknown;
}
export interface RecordDecisionDeps {
  readonly logger?: Logger;
}
export interface RecordDecisionOptions {
  readonly correlationId?: string;
  /** TEST SEAM ONLY: override the in-tx audit writer to force a failure (prove the decision rolls back). */
  readonly auditWriter?: AuditWriteFn;
}

export type RecordDecisionResult =
  | { readonly status: 'ok'; readonly decision: DecisionDTO }
  | { readonly status: 'forbidden' }
  // The generation or the selection is absent/invisible, or the selection belongs to a different generation.
  | { readonly status: 'not_found' }
  // A supplied rationale is unusable (non-string / over-long) — deny-by-default, nothing persisted.
  | { readonly status: 'invalid' };

export async function recordDecision(
  client: DatabaseClient,
  params: RecordDecisionParams,
  deps: RecordDecisionDeps = {},
  options: RecordDecisionOptions = {},
): Promise<RecordDecisionResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const optsBase = { ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}), ...(deps.logger !== undefined ? { logger: deps.logger } : {}) };

  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<RecordDecisionResult> => {
      // Owner-only: a viewer may generate and recommend, but only the owner decides (J-08 "Actor: owner"). AUTHZ FIRST,
      // then input validation — an unauthorized caller learns `forbidden`, never whether their input would have parsed.
      if (checkAuthorization(role, 'decision:record', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { status: 'forbidden' };
      // A present-but-unusable rationale denies before any write (the insert below is the first mutation).
      const rationale = normalizeDecisionRationale(params.rationale);
      if (rationale === undefined) return { status: 'invalid' };
      const repo = new StrategyRepository(scope.db);
      const generation = await repo.findGeneration(params.generationId);
      if (generation === undefined) return { status: 'not_found' };
      // The selection must exist, be visible in this company scope, AND belong to THIS generation (the composite FK
      // enforces the same rule at the DB; checking here turns a constraint throw into a clean `not_found`).
      const selection = await repo.findSelection(params.selectionId);
      if (selection === undefined || selection.generation_id !== params.generationId) return { status: 'not_found' };

      // "Options considered" = this generation's immutable option set; the count is what the audit event carries.
      const optionsConsideredCount = (await repo.listOptions(params.generationId)).length;

      const row = await repo.insertDecision({
        accountId: params.accountId,
        companyId: params.companyId,
        generationId: params.generationId,
        selectionId: params.selectionId,
        // Snapshot the hardened selection's mode so a consumer (notably the P4-001 planning gate) can distinguish a
        // rejection from a positive decision without re-reading the selection, which may since have been superseded.
        mode: selection.mode,
        // Snapshot the generation's understanding version — STRAT-006 "linked to the understanding version".
        understandingVersion: generation.understanding_version,
        rationale,
        createdByUserId: params.userId,
      });
      // decision.recorded in the SAME transaction. This IS the STRAT-006 guarantee: an audit failure rolls the decision
      // back, so a decision is never silently unrecorded. Metadata is scalar only — never content or rationale text.
      await audit(
        scope,
        decisionRecorded({ decisionId: row.id, understandingVersion: row.understanding_version, optionsConsideredCount, mode: row.mode }),
        options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
      );
      deps.logger?.info('decision.recorded', { metadata: { accountId: params.accountId, companyId: params.companyId, generationId: params.generationId, understandingVersion: row.understanding_version, mode: row.mode } });
      return { status: 'ok', decision: toDecisionDTO(row, optionsConsideredCount) };
    },
    optsBase,
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

/** Map a persisted decision row (+ the count of options considered) to the redacted DTO. */
export function toDecisionDTO(row: DecisionRow, optionsConsideredCount: number): DecisionDTO {
  return {
    decisionId: row.id,
    generationId: row.generation_id,
    selectionId: row.selection_id,
    mode: row.mode as DecisionDTO['mode'],
    understandingVersion: row.understanding_version,
    optionsConsideredCount,
    rationale: row.rationale,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
