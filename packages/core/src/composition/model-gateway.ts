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
import { UsageEventRepository, withTenantTransaction, type DatabaseClient, type TenantContext } from '@acbp/database';
import type { ModelGatewayRequest, ModelGatewayResult, NewModelCallUsageEvent } from '@acbp/contracts';
import type { Logger } from '@acbp/observability';
import { callModel, type CostInput, type GatewayConfig, type ModelGatewayDeps, type OutputValidation, type PolicyDecision, type ResolvedProvider } from '../model/model-gateway.js';

export interface ModelGatewayCompositionConfig {
  readonly primary: ResolvedProvider;
  readonly fallback?: ResolvedProvider;
  readonly estimateCost: (input: CostInput) => number;
  readonly validateOutput?: (schemaRef: string, output: string) => OutputValidation;
  readonly policyPrecheck?: (request: ModelGatewayRequest) => PolicyDecision | Promise<PolicyDecision>;
  readonly config?: GatewayConfig;
  readonly logger?: Logger;
}

export interface CallModelOptions {
  readonly correlationId?: string;
}

export type BoundModelGateway = (request: ModelGatewayRequest, options?: CallModelOptions) => Promise<ModelGatewayResult>;

/** Persist one usage event under the request's company scope (fail-closed: a write failure throws → rollback). */
async function writeUsageEvent(client: DatabaseClient, event: NewModelCallUsageEvent, correlationId: string | undefined): Promise<void> {
  const tenant: TenantContext = { accountId: event.accountId, companyId: event.companyId };
  await withTenantTransaction(
    client,
    tenant,
    async (scope) => {
      await new UsageEventRepository(scope.db).insert({
        accountId: event.accountId,
        companyId: event.companyId,
        provider: event.provider,
        model: event.model,
        taskClass: event.taskClass,
        outcome: event.outcome,
        errorCategory: event.errorCategory ?? null,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        estimatedCostMicros: event.estimatedCostMicros,
        fallbackUsed: event.fallbackUsed,
        latencyMs: event.latencyMs,
        correlationId: event.correlationId ?? null,
      });
    },
    correlationId !== undefined ? { correlationId } : {},
  );
}

/**
 * Build a company-scoped model gateway bound to `client`. Each call runs the injected provider(s) through the
 * gateway and meters the result into `usage_events` under the request's company scope.
 */
export function createModelGateway(client: DatabaseClient, cfg: ModelGatewayCompositionConfig): BoundModelGateway {
  return (request, options) => {
    const correlationId = options?.correlationId ?? request.correlationId;
    const deps: ModelGatewayDeps = {
      primary: cfg.primary,
      estimateCost: cfg.estimateCost,
      recordUsage: (event) => writeUsageEvent(client, event, correlationId),
      ...(cfg.fallback !== undefined ? { fallback: cfg.fallback } : {}),
      ...(cfg.validateOutput !== undefined ? { validateOutput: cfg.validateOutput } : {}),
      ...(cfg.policyPrecheck !== undefined ? { policyPrecheck: cfg.policyPrecheck } : {}),
      ...(cfg.config !== undefined ? { config: cfg.config } : {}),
      ...(cfg.logger !== undefined ? { logger: cfg.logger } : {}),
    };
    return callModel(deps, request);
  };
}
