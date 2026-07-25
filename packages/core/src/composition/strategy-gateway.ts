// @acbp/core/composition — strategy-option generation gateway output validation (ACBP-P3-001; CDR-034).
//
// The `validateOutput` the model gateway (P2-003) is configured with for strategy generation: it dispatches on the
// request's `outputSchemaRef` to `parseStrategyOptions` (deny-by-default; the 16-field standard, ADR-019 no fake
// precision). An unknown ref fails closed (`invalid_output`). This turns the raw model output string into the validated
// structured object the use case consumes via `result.validatedOutput`.
import { STRATEGY_OPTIONS_SCHEMA, STRATEGY_RECOMMENDATION_SCHEMA, parseStrategyOptions, parseStrategyRecommendation } from '@acbp/contracts';
import type { OutputValidation } from '../model/model-gateway.js';

/** Route a strategy-generation output to its parser; unknown ref → fail closed. */
export function strategyOutputValidator(schemaRef: string, output: string): OutputValidation {
  if (schemaRef === STRATEGY_OPTIONS_SCHEMA) return parseStrategyOptions(output);
  return { ok: false };
}

/** Route a strategy-recommendation output to its SHAPE parser (ACBP-P3-003; CDR-036); unknown ref → fail closed. */
export function strategyRecommendationValidator(schemaRef: string, output: string): OutputValidation {
  if (schemaRef === STRATEGY_RECOMMENDATION_SCHEMA) return parseStrategyRecommendation(output);
  return { ok: false };
}
