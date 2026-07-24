// @acbp/core — adaptive-orchestration gateway-request builders (ACBP-P2-005; CDR-028; DISC-001..006).
//
// PURE builders that turn interview inputs into a well-formed ModelGatewayRequest: each pins a REGISTERED template
// (P2-004), renders its segments with the inputs, and stamps the correct task/timeout class + output-schema ref +
// tenant identity. Full context assembly (provenance-ranked memory + secret blocklist + MEM-004 precedence) is
// P2-007 — here the prior answers are passed as the rendered template's own slot (CDR-028 §1). No DB, no network.
import {
  ANSWER_QUALITY_SCHEMA,
  ASSUMPTION_SCHEMA,
  INTERVIEW_FOLLOWUPS_SCHEMA,
  renderTemplateSegments,
  resolveTemplateRef,
  templateRef,
  timeoutClassForTask,
  type ModelContextPart,
  type ModelGatewayRequest,
  type TemplateDefinition,
} from '@acbp/contracts';

export interface FollowupsInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly priorAnswers: string;
  readonly focusArea: string;
  readonly correlationId?: string;
}
export interface AnswerQualityInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly answer: string;
  readonly priorAnswers: string;
  readonly correlationId?: string;
}
export interface AssumptionInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly question: string;
  readonly priorAnswers: string;
  readonly correlationId?: string;
}

/** Assemble the common request shape from a resolved template + rendered slot values. */
function toRequest(def: TemplateDefinition, values: Readonly<Record<string, string>>, outputSchemaRef: string, ids: { accountId: string; companyId: string; correlationId?: string }): ModelGatewayRequest {
  const contextParts: ModelContextPart[] = renderTemplateSegments(def, values).map((s) => ({ role: s.role, content: s.text }));
  return {
    taskClass: def.taskClass,
    templateRef: templateRef(def),
    contextParts,
    outputSchemaRef,
    timeoutClass: timeoutClassForTask(def.taskClass),
    companyId: ids.companyId,
    accountId: ids.accountId,
    ...(ids.correlationId !== undefined ? { correlationId: ids.correlationId } : {}),
  };
}

/** Build the follow-up generation request (DISC-001/002). `priorAnswers` may be empty for the first batch. */
export function buildFollowupsRequest(input: FollowupsInput): ModelGatewayRequest {
  const def = resolveTemplateRef('interview.followups@1');
  return toRequest(def, { prior_answers: input.priorAnswers, focus_area: input.focusArea }, INTERVIEW_FOLLOWUPS_SCHEMA, input);
}

/** Build the answer-quality detection request (DISC-003/004). */
export function buildAnswerQualityRequest(input: AnswerQualityInput): ModelGatewayRequest {
  const def = resolveTemplateRef('interview.answer_quality@1');
  return toRequest(def, { answer: input.answer, prior_answers: input.priorAnswers }, ANSWER_QUALITY_SCHEMA, input);
}

/** Build the assumption-suggestion request for an "I don't know" answer (DISC-005). */
export function buildAssumptionRequest(input: AssumptionInput): ModelGatewayRequest {
  const def = resolveTemplateRef('interview.assumption@1');
  return toRequest(def, { question: input.question, prior_answers: input.priorAnswers }, ASSUMPTION_SCHEMA, input);
}
