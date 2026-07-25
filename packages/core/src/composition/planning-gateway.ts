// @acbp/core/composition — roadmap planning gateway output validation (ACBP-P4-001; CDR-039).
//
// The `validateOutput` the model gateway (P2-003) is configured with for roadmap generation: it dispatches on the
// request's `outputSchemaRef` to `parseRoadmapOutput` (deny-by-default — one malformed member rejects the whole plan,
// a milestone can never dangle off a missing goal, and the `partial` flag is never coerced). An unknown ref fails
// closed (`invalid_output`). This turns the raw model output string into the validated structured object the use case
// consumes via `result.validatedOutput`.
import { ROADMAP_SCHEMA, parseRoadmapOutput } from '@acbp/contracts';
import type { OutputValidation } from '../model/model-gateway.js';

/** Route a roadmap-planning output to its parser; unknown ref → fail closed. */
export function roadmapOutputValidator(schemaRef: string, output: string): OutputValidation {
  if (schemaRef === ROADMAP_SCHEMA) return parseRoadmapOutput(output);
  return { ok: false };
}
