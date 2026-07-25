// @acbp/core — owner strategy decision use case (ACBP-P3-004; CDR-037; STRAT-003/005).
//
// Record the OWNER's decision over a generation's options in one of four modes (CDR-037 §1):
//   - select   — an existing option is chosen.
//   - edit      — an option is chosen AND revised (owner-supplied fields; NO model call).
//   - combine   — a new option is authored from several (owner-supplied fields; NO model call).
//   - reject    — none fit; the owner records reasons and asks for another round (request-another is strategy:generate).
// Owner-only (`strategy:select`; the understanding:confirm precedent — a viewer cannot decide). The decision is
// validated per-mode (deny-by-default; the contract `validateStrategyDecision`) and persisted as ONE immutable selection
// row + the `strategy.selected` audit event in a SINGLE company-scoped transaction (audit-or-nothing). This records a
// SELECTION ONLY — it is NOT a decision record (decision.recorded is P3-005) and unlocks NO planning (the P4 boundary).
// phase_scope is FLAGGING only (STRAT-005). No model gateway is involved.
import { StrategyRepository, writeAuditEvent, type DatabaseClient, type AuditScope, type AuditWriteContext, type StrategySelectionRow, type StrategyOptionRow } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import {
  strategySelected,
  validateStrategyDecision,
  type AuditEvent,
  type StrategyDecisionRequest,
  type ValidatedStrategyDecision,
  type StrategySelectionDTO,
  type StrategyPhaseScope,
  type StrategyOptionFields,
} from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

type AuditWriteFn = (scope: AuditScope, event: AuditEvent, ctx?: AuditWriteContext) => Promise<string>;

export interface RecordStrategyDecisionParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly generationId: string;
  readonly request: StrategyDecisionRequest;
}
export interface RecordStrategyDecisionDeps {
  readonly logger?: Logger;
}
export interface RecordStrategyDecisionOptions {
  readonly correlationId?: string;
  /** TEST SEAM ONLY: override the in-tx audit writer to force a failure (prove the selection rolls back). */
  readonly auditWriter?: AuditWriteFn;
}

export type RecordStrategyDecisionResult =
  | { readonly status: 'ok'; readonly selection: StrategySelectionDTO }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  // The decision request failed per-mode validation (bad mode/ordinal/shape) — deny-by-default, nothing persisted.
  | { readonly status: 'invalid' };

/** The phase scope carried by a validated decision — reject carries none (STRAT-005). */
function phaseScopeOf(decision: ValidatedStrategyDecision): StrategyPhaseScope | null {
  return decision.mode === 'reject' ? null : decision.phaseScope;
}
/** The authored/base fields for the persisted row — only edit/combine author fields; select/reject author none. */
function chosenFieldsOf(decision: ValidatedStrategyDecision): StrategyOptionFields | null {
  return decision.mode === 'edit' || decision.mode === 'combine' ? decision.chosenFields : null;
}
/** The base/selected ordinal a decision names, or null (combine/reject name none; an edit MAY omit a base). */
function selectedOrdinalOf(decision: ValidatedStrategyDecision): number | null {
  if (decision.mode === 'select') return decision.selectedOrdinal;
  if (decision.mode === 'edit') return decision.selectedOrdinal;
  return null;
}

export async function recordStrategyDecision(
  client: DatabaseClient,
  params: RecordStrategyDecisionParams,
  deps: RecordStrategyDecisionDeps = {},
  options: RecordStrategyDecisionOptions = {},
): Promise<RecordStrategyDecisionResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const optsBase = { ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}), ...(deps.logger !== undefined ? { logger: deps.logger } : {}) };

  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<RecordStrategyDecisionResult> => {
      // Owner-only: a viewer cannot decide (the understanding:confirm precedent).
      if (checkAuthorization(role, 'strategy:select', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { status: 'forbidden' };
      const repo = new StrategyRepository(scope.db);
      const generation = await repo.findGeneration(params.generationId);
      if (generation === undefined) return { status: 'not_found' };
      const optionRows = await repo.listOptions(params.generationId);

      // Validate the decision against THIS generation's option count (deny-by-default; per-mode shape).
      const parse = validateStrategyDecision(params.request, optionRows.length);
      if (!parse.ok) return { status: 'invalid' };
      const decision = parse.value;

      // Resolve the named option BY ORDINAL (robust even if ordinals were ever non-contiguous). A named-but-absent
      // ordinal is an invalid decision (defensive — validateStrategyDecision already bounds it to [0, optionCount)).
      const ordinal = selectedOrdinalOf(decision);
      let selectedOptionId: string | null = null;
      if (ordinal !== null) {
        const option = optionRows.find((o) => o.ordinal === ordinal);
        if (option === undefined) return { status: 'invalid' };
        selectedOptionId = option.id;
      }

      const row = await repo.insertSelection({
        accountId: params.accountId,
        companyId: params.companyId,
        generationId: params.generationId,
        mode: decision.mode,
        selectedOptionId,
        chosenFields: chosenFieldsOf(decision),
        phaseScope: phaseScopeOf(decision),
        reasons: decision.mode === 'reject' ? decision.reasons : null,
        createdByUserId: params.userId,
      });
      // strategy.selected in the SAME transaction — an audit failure rolls the selection back (audit-or-nothing). The
      // event carries only {mode} (+ phase_scope when set) — never the chosen fields, the option content, or reasons.
      await audit(scope, strategySelected({ selectionId: row.id, mode: row.mode, phaseScope: row.phase_scope }), options.correlationId !== undefined ? { correlationId: options.correlationId } : {});
      deps.logger?.info('strategy.selected', { metadata: { accountId: params.accountId, companyId: params.companyId, generationId: params.generationId, mode: row.mode, phaseScope: row.phase_scope } });
      return { status: 'ok', selection: toSelectionDTO(row) };
    },
    optsBase,
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

/** Map a persisted selection row to the DTO (chosen_fields is the validated 16-field object or null). */
export function toSelectionDTO(row: StrategySelectionRow): StrategySelectionDTO {
  return {
    selectionId: row.id,
    mode: row.mode as StrategySelectionDTO['mode'],
    selectedOptionId: row.selected_option_id,
    chosenFields: (row.chosen_fields as StrategyOptionFields | null) ?? null,
    phaseScope: row.phase_scope as StrategyPhaseScope | null,
    reasons: row.reasons,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// Re-export the option-row type consumers may need when threading selections through reads.
export type { StrategyOptionRow };
