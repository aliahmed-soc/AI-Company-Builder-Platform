// @acbp/core — advisory AI recommendation use case (ACBP-P3-003; CDR-036; STRAT-004).
//
// Produce an OPTIONAL, ADVISORY recommendation over a generation's genuinely-distinct options. The recommendation
// recommends ONE option with an explicit rationale + key sensitivities, or honestly abstains. STRAT-004 guards:
//   - NEVER auto-selects — this use case writes NO selection, NO decision record, NO state transition (advisory only;
//     selection is P3-004, decision records P3-005). A recommendation row merely references an option id.
//   - "Absent a defensible rationale, no recommendation is shown" — DENY-BY-DEFAULT: a recommendation is persisted ONLY
//     when the model names one option in range + supplies a non-blank bounded rationale + non-blank bounded
//     sensitivities; any miss (or an explicit abstain) persists NOTHING and returns `recommendation: null`.
// The model call runs BETWEEN scoped operations (never in a held tx); it is metered by the gateway. NO audit event
// (the recommendation changes no state — CDR-036 §4). Live provider deferred (CDR-026 §0); FakeModelProvider now.
import { StrategyRepository, type DatabaseClient, type StrategyRecommendationRow, type StrategyOptionRow } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import {
  narrowStrategyRecommendation,
  resolveRecommendation,
  resolveTemplateRef,
  renderTemplateSegments,
  templateRef,
  timeoutClassForTask,
  STRATEGY_RECOMMENDATION_SCHEMA,
  type ModelContextPart,
  type ModelGatewayRequest,
  type ModelGatewayResult,
  type StrategyRecommendationDTO,
} from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

export type ModelGateway = (request: ModelGatewayRequest, options?: { readonly correlationId?: string }) => Promise<ModelGatewayResult>;

const OPTIONS_PROMPT_MAX = 12_000;

export interface RecommendStrategyParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly generationId: string;
}
export interface StrategyRecommendationDeps {
  readonly gateway: ModelGateway;
  readonly logger?: Logger;
}
export interface StrategyRecommendationOptions {
  readonly correlationId?: string;
}

export type RecommendStrategyResult =
  | { readonly status: 'ok'; readonly recommendation: StrategyRecommendationDTO | null }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'recommendation_failed' };

/** Render a generation's options into the bounded `{{options}}` prompt text (by ordinal; the model's reference set). */
export function formatOptionsForRecommendation(options: readonly StrategyOptionRow[]): string {
  return options
    .map((o) => `Option ${o.ordinal}: customer=${o.fields['customer'] ?? ''}; offer=${o.fields['offer'] ?? ''}; business_model=${o.fields['business_model'] ?? ''}; description=${o.fields['description'] ?? ''}`)
    .join('\n')
    .slice(0, OPTIONS_PROMPT_MAX);
}

/** Build the recommendation gateway request (pins the registered template + output schema). */
export function buildRecommendationRequest(input: { accountId: string; companyId: string; options: string; correlationId?: string }): ModelGatewayRequest {
  const def = resolveTemplateRef('strategy.recommend@1');
  const contextParts: ModelContextPart[] = renderTemplateSegments(def, { options: input.options }).map((s) => ({ role: s.role, content: s.text }));
  return {
    taskClass: def.taskClass,
    templateRef: templateRef(def),
    contextParts,
    outputSchemaRef: STRATEGY_RECOMMENDATION_SCHEMA,
    timeoutClass: timeoutClassForTask(def.taskClass),
    companyId: input.companyId,
    accountId: input.accountId,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  };
}

type PreRead = { readonly kind: 'ready'; readonly options: readonly StrategyOptionRow[] } | { readonly kind: 'forbidden' } | { readonly kind: 'not_found' };

export async function recommendStrategy(client: DatabaseClient, params: RecommendStrategyParams, deps: StrategyRecommendationDeps, options: StrategyRecommendationOptions = {}): Promise<RecommendStrategyResult> {
  const optsBase = { ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}), ...(deps.logger !== undefined ? { logger: deps.logger } : {}) };

  // 1. Load the generation's options (own scope; strategy:recommend authz).
  const read = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<PreRead> => {
      if (checkAuthorization(role, 'strategy:recommend', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { kind: 'forbidden' };
      const repo = new StrategyRepository(scope.db);
      const generation = await repo.findGeneration(params.generationId);
      if (generation === undefined) return { kind: 'not_found' };
      return { kind: 'ready', options: await repo.listOptions(params.generationId) };
    },
    optsBase,
  );
  if (read.kind !== 'ran') return { status: 'forbidden' };
  const pre = read.value;
  if (pre.kind === 'forbidden') return { status: 'forbidden' };
  if (pre.kind === 'not_found') return { status: 'not_found' };
  // A generation with no options cannot be recommended over — honest no-recommendation (nothing persisted).
  if (pre.options.length === 0) return { status: 'ok', recommendation: null };

  // 2. Call the gateway (external; its own usage-metering tx). Model call BETWEEN scoped operations.
  const request = buildRecommendationRequest({ accountId: params.accountId, companyId: params.companyId, options: formatOptionsForRecommendation(pre.options), ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}) });
  const result = await deps.gateway(request, options.correlationId !== undefined ? { correlationId: options.correlationId } : {});
  if (result.outcome !== 'ok') return { status: 'recommendation_failed' };

  // 3. Defensively narrow the gateway's already-validated output (no raw re-parse) + resolve (deny-by-default). A
  //    corrupted seam value is a failure; a well-formed but undefensible/abstaining output → honest no-recommendation.
  const narrowed = narrowStrategyRecommendation(result.validatedOutput);
  if (narrowed === undefined) return { status: 'recommendation_failed' };
  const resolved = resolveRecommendation(narrowed, pre.options.length);
  if (resolved === null) return { status: 'ok', recommendation: null };
  // Resolve the recommended option BY ORDINAL (not array index) — robust even if ordinals were ever non-contiguous.
  const recommendedOption = pre.options.find((o) => o.ordinal === resolved.recommendedOrdinal);
  if (recommendedOption === undefined) return { status: 'ok', recommendation: null }; // defensive: ordinal not present

  // 4. Persist ONE immutable advisory recommendation (append-only). NO selection, NO state change, NO audit event.
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<RecommendStrategyResult> => {
      if (checkAuthorization(role, 'strategy:recommend', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { status: 'forbidden' };
      const repo = new StrategyRepository(scope.db);
      // Re-verify the generation still exists (a company/account cascade-delete could have raced the model call) —
      // a clean `not_found` beats an FK-violation throw at insert.
      if ((await repo.findGeneration(params.generationId)) === undefined) return { status: 'not_found' };
      const row = await repo.insertRecommendation({
        accountId: params.accountId,
        companyId: params.companyId,
        generationId: params.generationId,
        recommendedOptionId: recommendedOption.id,
        rationale: resolved.rationale,
        sensitivities: resolved.sensitivities,
        createdByUserId: params.userId,
      });
      deps.logger?.info('strategy.recommended', { metadata: { accountId: params.accountId, companyId: params.companyId, generationId: params.generationId, recommendedOrdinal: resolved.recommendedOrdinal } });
      return { status: 'ok', recommendation: toRecommendationDTO(row, resolved.recommendedOrdinal) };
    },
    optsBase,
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

/** Map a persisted recommendation row (+ the recommended option's ordinal) to the redacted DTO. */
export function toRecommendationDTO(row: StrategyRecommendationRow, recommendedOrdinal: number): StrategyRecommendationDTO {
  return {
    recommendationId: row.id,
    recommendedOptionId: row.recommended_option_id,
    recommendedOrdinal,
    rationale: row.rationale,
    sensitivities: row.sensitivities,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
