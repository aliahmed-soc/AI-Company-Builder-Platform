// @acbp/core/composition — interview-orchestration gateway output validation (ACBP-P2-005; CDR-028).
//
// The single `validateOutput` the model gateway (P2-003) is configured with for the adaptive interview calls: it
// dispatches on the request's `outputSchemaRef` to the matching deny-by-default parser (P2-005 contracts). An
// unknown ref fails closed (`invalid_output`). This is the seam that turns a raw model output string into the
// validated structured object the orchestration use cases consume via `result.validatedOutput`.
import { ANSWER_QUALITY_SCHEMA, ASSUMPTION_SCHEMA, INTERVIEW_FOLLOWUPS_SCHEMA, parseAnswerQuality, parseAssumption, parseFollowUps } from '@acbp/contracts';
import type { OutputValidation } from '../model/model-gateway.js';

/** Route a gateway output to the parser named by its output-schema ref. Unknown ref → fail closed. */
export function interviewOutputValidator(schemaRef: string, output: string): OutputValidation {
  switch (schemaRef) {
    case INTERVIEW_FOLLOWUPS_SCHEMA:
      return parseFollowUps(output);
    case ANSWER_QUALITY_SCHEMA:
      return parseAnswerQuality(output);
    case ASSUMPTION_SCHEMA:
      return parseAssumption(output);
    default:
      return { ok: false };
  }
}
