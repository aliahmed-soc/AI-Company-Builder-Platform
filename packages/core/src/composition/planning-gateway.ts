// @acbp/core/composition — roadmap planning gateway output validation (ACBP-P4-001; CDR-039).
//
// The `validateOutput` the model gateway (P2-003) is configured with for roadmap generation: it dispatches on the
// request's `outputSchemaRef` to `parseRoadmapOutput` (deny-by-default — one malformed member rejects the whole plan,
// a milestone can never dangle off a missing goal, and the `partial` flag is never coerced). An unknown ref fails
// closed (`invalid_output`). This turns the raw model output string into the validated structured object the use case
// consumes via `result.validatedOutput`.
import { ROADMAP_SCHEMA, TASK_PLAN_SCHEMA, TASK_STEERING_SCHEMA, parseRoadmapOutput, parseTaskPlanOutput, parseSteeringOutput } from '@acbp/contracts';
import type { OutputValidation } from '../model/model-gateway.js';

/** Route a roadmap-planning output to its parser; unknown ref → fail closed. */
export function roadmapOutputValidator(schemaRef: string, output: string): OutputValidation {
  if (schemaRef === ROADMAP_SCHEMA) return parseRoadmapOutput(output);
  return { ok: false };
}

/**
 * Route a task-planning output to its parser (ACBP-P4-003). `milestoneCount` is the size of the IN-SCOPE milestone set
 * the model was shown, so a task naming an ordinal outside it — including one outside the STRAT-005 approved phase —
 * is rejected at the seam, before the use case ever sees it. Unknown ref → fail closed.
 */
export function taskPlanOutputValidator(milestoneCount: number): (schemaRef: string, output: string) => OutputValidation {
  return (schemaRef, output) => {
    if (schemaRef === TASK_PLAN_SCHEMA) return parseTaskPlanOutput(output, milestoneCount);
    if (schemaRef === TASK_STEERING_SCHEMA) return parseSteeringOutput(output, milestoneCount);
    return { ok: false };
  };
}
