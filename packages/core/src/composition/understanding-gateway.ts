// @acbp/core/composition — understanding-generation gateway output validation (ACBP-P2-008; CDR-029).
//
// The `validateOutput` the model gateway (P2-003) is configured with for understanding generation: it dispatches
// on the request's `outputSchemaRef` to `parseUnderstanding` (deny-by-default). An unknown ref fails closed
// (`invalid_output`). This turns the raw model output string into the validated structured object the use case
// consumes via `result.validatedOutput`.
import { UNDERSTANDING_SCHEMA, parseUnderstanding } from '@acbp/contracts';
import type { OutputValidation } from '../model/model-gateway.js';

/** Route an understanding-generation output to its parser; unknown ref → fail closed. */
export function understandingOutputValidator(schemaRef: string, output: string): OutputValidation {
  if (schemaRef === UNDERSTANDING_SCHEMA) return parseUnderstanding(output);
  return { ok: false };
}
