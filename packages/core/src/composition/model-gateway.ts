// @acbp/core/composition — model gateway wiring (ACBP-P2-003; ADR-011; CDR-026 §4/§5).
//
// Binds the provider-neutral `callModel` gateway to the concrete DB usage sink: `recordUsage` writes the
// append-only usage event under the request's COMPANY scope (dual-keyed RLS) in its own short transaction —
// AFTER the (external) model call, never holding a connection across it. FAIL-CLOSED metering is preserved
// end-to-end: a usage-write failure rolls the transaction back and throws, so `callModel` withholds the output.
//
// The gateway attributes usage to the request's `accountId`/`companyId`, which the trusted server caller
// supplies from an already-established company scope (P2-005/P2-007). No provider SDK is referenced here — the
// providers are injected (in P2-003, the deterministic fake; live adapters are a deferred owner gate, CDR-026 §0).
import { UsageEventRepository, withAccountTransaction, withTenantTransaction, type DatabaseClient, type TenantContext } from '@acbp/database';
import type { UsageCapsConfig } from '@acbp/config';
import { checkUsageCaps } from '../limits/usage-caps-service.js';
import type { ModelGatewayRequest, ModelGatewayResult, NewModelCallUsageEvent } from '@acbp/contracts';
import { recordSuppression, type Logger } from '@acbp/observability';
import { callModel, type CostInput, type GatewayConfig, type ModelGatewayDeps, type OutputValidation, type PolicyDecision, type ResolvedProvider } from '../model/model-gateway.js';

export interface ModelGatewayCompositionConfig {
  readonly primary: ResolvedProvider;
  readonly fallback?: ResolvedProvider;
  readonly estimateCost: (input: CostInput) => number;
  readonly validateOutput?: (schemaRef: string, output: string) => OutputValidation;
  /**
   * Overrides the caps pre-check entirely. Supplying BOTH this and `caps` is a programming error, not a merge —
   * see `createModelGateway`.
   */
  readonly policyPrecheck?: (request: ModelGatewayRequest) => PolicyDecision | Promise<PolicyDecision>;
  /**
   * CDR-008's spend ceilings, enforced before every model call (ACBP-P6-010; CDR-075; NFR-015).
   *
   * OPTIONAL, AND ITS ABSENCE MEANS NO CAP — which is the pre-P6-010 behaviour and is stated here rather than
   * left to be discovered. `policyPrecheck` has always been optional with a default of *always allowed*, so
   * every existing caller enforced nothing; making caps mandatory would have changed the meaning of every one
   * of them in a commit about limits. A composition that wants ceilings passes this.
   */
  readonly caps?: UsageCapsConfig;
  readonly config?: GatewayConfig;
  readonly logger?: Logger;
}

export interface CallModelOptions {
  readonly correlationId?: string;
}

export type BoundModelGateway = (request: ModelGatewayRequest, options?: CallModelOptions) => Promise<ModelGatewayResult>;

/**
 * Persist one usage event under the request's company scope (fail-closed: a write failure throws → rollback).
 *
 * A SUPPRESSED DUPLICATE IS NOT A FAILURE and must not throw (CDR-074 §2): metering is fail-closed, so throwing
 * here would withhold a model output the customer has already been charged for. It is recorded instead, because
 * a suppression that writes nothing and says nothing is indistinguishable from a suppression path that stopped
 * working — the ambiguity CDR-074 §0 is built around.
 */
async function writeUsageEvent(
  client: DatabaseClient,
  event: NewModelCallUsageEvent,
  correlationId: string | undefined,
  logger: Logger | undefined,
): Promise<void> {
  const tenant: TenantContext = { accountId: event.accountId, companyId: event.companyId };
  const result = await withTenantTransaction(
    client,
    tenant,
    async (scope) => {
      return new UsageEventRepository(scope.db).insert({
        accountId: event.accountId,
        companyId: event.companyId,
        provider: event.provider,
        model: event.model,
        taskClass: event.taskClass,
        outcome: event.outcome,
        errorCategory: event.errorCategory ?? null,
        // ACBP-P5-009: null unless the call fell over. The DB CHECK refuses a reason without a fallover.
        fallbackReason: event.fallbackReason ?? null,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        estimatedCostMicros: event.estimatedCostMicros,
        fallbackUsed: event.fallbackUsed,
        latencyMs: event.latencyMs,
        correlationId: event.correlationId ?? null,
        ...(event.idempotencyKey !== undefined ? { idempotencyKey: event.idempotencyKey } : {}),
      });
    },
    correlationId !== undefined ? { correlationId } : {},
  );

  // RECORDED AFTER THE TRANSACTION COMMITS, not inside it. Inside, a rollback would erase the row while the log
  // line survived, claiming a suppression that never happened.
  if (result.status === 'suppressed') {
    recordSuppression(logger, { surface: 'usage_event', accountId: event.accountId, companyId: event.companyId });
  }
}

/**
 * Build a company-scoped model gateway bound to `client`. Each call runs the injected provider(s) through the
 * gateway and meters the result into `usage_events` under the request's company scope.
 */
/**
 * Build the caps pre-check: read the account's and company's spend from the ledger, decide, and record.
 *
 * ITS OWN TRANSACTION, BEFORE the provider call and separate from the usage write. The check must complete and
 * commit its `usage.limit_reached` record whether or not the call that follows succeeds — a soft alert that
 * vanished because the model timed out would be a warning the founder never got.
 *
 * A THROW BECOMES A REFUSAL, never an allow. If the check itself fails, we do not know the spend, and that is
 * the same state `evaluateCaps` calls `halt` — reported as `internal`, ours to fix, not as the founder's budget.
 */
function capsPrecheck(client: DatabaseClient, caps: UsageCapsConfig, logger: Logger | undefined) {
  return async (request: ModelGatewayRequest): Promise<PolicyDecision> => {
    const at = new Date();
    try {
      const decision = await withAccountTransaction(
        client,
        { accountId: request.accountId },
        async (scope) => checkUsageCaps(scope, { companyId: request.companyId, at }, caps, { ...(logger !== undefined ? { logger } : {}), ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}) }),
        request.correlationId !== undefined ? { correlationId: request.correlationId } : {},
      );
      if (decision.outcome === 'block') return { allowed: false, errorCategory: 'budget_exceeded' };
      if (decision.outcome === 'halt') return { allowed: false, errorCategory: 'internal' };
      return { allowed: true };
    } catch {
      return { allowed: false, errorCategory: 'internal' };
    }
  };
}

export function createModelGateway(client: DatabaseClient, cfg: ModelGatewayCompositionConfig): BoundModelGateway {
  // BOTH IS A PROGRAMMING ERROR, not a merge. Silently preferring one would make a caller who supplied caps
  // believe they were enforced while a hand-written precheck answered instead — the cap would be configured,
  // documented, and inert.
  if (cfg.policyPrecheck !== undefined && cfg.caps !== undefined) {
    throw new TypeError('createModelGateway: supply either `policyPrecheck` or `caps`, never both — a caps config that is silently overridden is a limit nobody is enforcing.');
  }
  const precheck = cfg.policyPrecheck ?? (cfg.caps !== undefined ? capsPrecheck(client, cfg.caps, cfg.logger) : undefined);

  return (request, options) => {
    const correlationId = options?.correlationId ?? request.correlationId;
    const deps: ModelGatewayDeps = {
      primary: cfg.primary,
      estimateCost: cfg.estimateCost,
      recordUsage: (event) => writeUsageEvent(client, event, correlationId, cfg.logger),
      ...(cfg.fallback !== undefined ? { fallback: cfg.fallback } : {}),
      ...(cfg.validateOutput !== undefined ? { validateOutput: cfg.validateOutput } : {}),
      ...(precheck !== undefined ? { policyPrecheck: precheck } : {}),
      ...(cfg.config !== undefined ? { config: cfg.config } : {}),
      ...(cfg.logger !== undefined ? { logger: cfg.logger } : {}),
    };
    return callModel(deps, request);
  };
}
