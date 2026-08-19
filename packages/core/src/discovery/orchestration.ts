// @acbp/core — adaptive interview orchestration use cases (ACBP-P2-005; CDR-028; DISC-001..006).
//
// Composes the existing scoped primitives (getSessionQa / addInterviewQuestion — P2-002; createMemoryItem —
// P2-006) with a model call through the P2-003 GATEWAY (injected, so this stays provider-neutral; in P2-005 the
// composition wires the deterministic fake provider — live generation is the deferred owner gate CDR-026 §0).
// The model call happens BETWEEN scoped operations, never inside a held transaction: read prior answers (its own
// scope) → call the gateway (external + its own usage-metering tx) → persist (its own scope). Accountability is
// the gateway's fail-closed usage metering (P2-005 audit = "model usage metered"); conflict-EVENT auditing is
// P2-007.
import type { DatabaseClient } from '@acbp/database';
import type { Logger } from '@acbp/observability';
import type { ModelGatewayRequest, ModelGatewayResult, QuestionDTO, QuestionSource, SessionQADTO, PublicErrorEnvelope } from '@acbp/contracts';
import { validateAnswerSubmission } from '@acbp/contracts';
import { addInterviewQuestion, getSessionQa } from './interview-qa.js';
import { createMemoryItem } from '../memory/memory-item.js';
import { buildAnswerQualityRequest, buildAssumptionRequest, buildFollowupsRequest } from './orchestration-requests.js';
import { planFollowUpBatch, resolveAnswerQuality, resolveAssumption } from './orchestration-plan.js';

/** The injected model gateway (structurally the composition's BoundModelGateway — keeps this decoupled). */
export type ModelGateway = (request: ModelGatewayRequest, options?: { readonly correlationId?: string }) => Promise<ModelGatewayResult>;

export interface OrchestrationDeps {
  readonly gateway: ModelGateway;
  readonly logger?: Logger;
}
export interface OrchestrationOptions {
  readonly correlationId?: string;
}

export interface GenerateBatchParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly sessionId: string;
  /** The topic the follow-ups should probe (e.g. 'target market'). */
  readonly focusArea: string;
}
export interface EvaluateAnswerParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly answerText: string;
}
export interface SuggestAssumptionParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly sessionId: string;
  readonly questionId: string;
}

export type GenerateBatchResult =
  | { readonly status: 'ok'; readonly source: QuestionSource; readonly questions: readonly QuestionDTO[] }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' };
export type EvaluateAnswerResult =
  | { readonly status: 'ok'; readonly verdict: 'clear'; readonly memoryItemId: string | null }
  | { readonly status: 'ok'; readonly verdict: 'vague'; readonly clarification: string }
  | { readonly status: 'ok'; readonly verdict: 'contradictory'; readonly conflict: string }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'validation'; readonly error: PublicErrorEnvelope };
export type SuggestAssumptionResult =
  | { readonly status: 'ok'; readonly assumption: string | null; readonly memoryItemId: string | null }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' };

const PRIOR_ANSWERS_MAX = 6_000;

/** Build the bounded `prior_answers` prompt text from the session Q&A (answered questions only, newest last). */
export function formatPriorAnswers(qa: SessionQADTO, excludeQuestionId?: string): string {
  const lines: string[] = [];
  for (const item of qa.items) {
    if (item.question.questionId === excludeQuestionId) continue;
    const ans = item.currentAnswer;
    if (ans === null || ans.status !== 'answered' || ans.content === null) continue;
    lines.push(`Q: ${item.question.prompt}\nA: ${ans.content}`);
  }
  if (lines.length === 0) return 'No prior answers yet.';
  return lines.join('\n\n').slice(0, PRIOR_ANSWERS_MAX);
}

function corr(options: OrchestrationOptions): { correlationId?: string } {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}

// ── generate an adaptive follow-up batch (DISC-001/002/006) ────────────────────────────────────────────
export async function generateAdaptiveBatch(client: DatabaseClient, params: GenerateBatchParams, deps: OrchestrationDeps, options: OrchestrationOptions = {}): Promise<GenerateBatchResult> {
  const qa = await getSessionQa(client, { userId: params.userId, accountId: params.accountId, companyId: params.companyId, sessionId: params.sessionId }, options);
  if (qa.status === 'forbidden') return { status: 'forbidden' };
  if (qa.status === 'not_found') return { status: 'not_found' };

  const priorAnswers = formatPriorAnswers(qa.qa);
  const request = buildFollowupsRequest({ accountId: params.accountId, companyId: params.companyId, priorAnswers, focusArea: params.focusArea, ...corr(options) });
  const result = await deps.gateway(request, corr(options));
  const plan = planFollowUpBatch(result, params.focusArea);

  const questions: QuestionDTO[] = [];
  for (const q of plan.questions) {
    const added = await addInterviewQuestion(client, { userId: params.userId, accountId: params.accountId, companyId: params.companyId, sessionId: params.sessionId, prompt: q.prompt, rationale: q.rationale, source: plan.source }, options);
    if (added.status === 'ok') questions.push(added.question);
    else if (added.status === 'forbidden') return { status: 'forbidden' };
    else if (added.status === 'not_found') return { status: 'not_found' };
    // 'validation' can't occur for our bounded prompts; skip defensively rather than surface a 500.
  }
  deps.logger?.info('interview.batch_generated', { metadata: { accountId: params.accountId, companyId: params.companyId, source: plan.source, count: questions.length } });
  return { status: 'ok', source: plan.source, questions };
}

// ── evaluate an answer: vague / contradiction / clear (DISC-003/004; clear → typed memory) ──────────────
export async function evaluateAnswer(client: DatabaseClient, params: EvaluateAnswerParams, deps: OrchestrationDeps, options: OrchestrationOptions = {}): Promise<EvaluateAnswerResult> {
  const qa = await getSessionQa(client, { userId: params.userId, accountId: params.accountId, companyId: params.companyId, sessionId: params.sessionId }, options);
  if (qa.status === 'forbidden') return { status: 'forbidden' };
  if (qa.status === 'not_found') return { status: 'not_found' };
  const target = qa.qa.items.find((i) => i.question.questionId === params.questionId);
  if (target === undefined) return { status: 'not_found' };

  /*
   * ⚠️ VALIDATE BEFORE YOU SPEND. This refusal is BEFORE the gateway call, and that ordering is the point.
   *
   * An adversarial review on ACBP-API-013 found that an over-long answer passed every free check, consumed the
   * per-company paid-call ceiling, was sent verbatim to the provider, was BILLED, and was only then refused —
   * by `createMemoryItem` below, on `MEMORY_CONTENT_MAX`, and only on a `clear` verdict. Text this long could
   * never have been stored as an answer either (`recordInterviewAnswer` refuses it at `ANSWER_CONTENT_MAX`), so
   * the model was being asked to judge something the platform had already decided it would not keep.
   *
   * THE RULE IS IMPORTED, NOT RESTATED. `validateAnswerSubmission` is the exact predicate `recordInterviewAnswer`
   * applies to the same text, so this cannot drift into refusing something the answer path would accept, or vice
   * versa — and the founder gets the identical bounded message either way. A hand-rolled length check here would
   * have been a second definition of "too long".
   *
   * Reachable only from a non-console client — the console gates its own control on the same constant — which is
   * exactly why it belongs here rather than in a screen.
   */
  const bounded = validateAnswerSubmission({ status: 'answered', content: params.answerText });
  if (!bounded.ok) return { status: 'validation', error: bounded.error };

  const priorAnswers = formatPriorAnswers(qa.qa, params.questionId);
  const request = buildAnswerQualityRequest({ accountId: params.accountId, companyId: params.companyId, answer: params.answerText, priorAnswers, ...corr(options) });
  const quality = resolveAnswerQuality(await deps.gateway(request, corr(options)));

  if (quality.verdict === 'vague') return { status: 'ok', verdict: 'vague', clarification: quality.detail ?? 'Could you be more specific?' };
  // A contradiction is SURFACED (never a silent override — MEM-004 spirit); the founder resolves it. Conflict-event
  // auditing is P2-007; here the accountability is the metered model call.
  if (quality.verdict === 'contradictory') return { status: 'ok', verdict: 'contradictory', conflict: quality.detail ?? 'This appears to conflict with an earlier answer.' };

  // Clear → the answer is a founder-stated fact; store it as a `user_fact` typed memory item via the interview
  // source path (type-by-source-path: interview_answer may carry user_fact — P2-006). Audited as memory.item_created.
  const mem = await createMemoryItem(client, { userId: params.userId, accountId: params.accountId, companyId: params.companyId, type: 'user_fact', content: params.answerText, sourceType: 'interview_answer', sourceRef: `question:${params.questionId}` }, options);
  if (mem.status === 'forbidden') return { status: 'forbidden' };
  if (mem.status === 'validation') return { status: 'validation', error: mem.error };
  return { status: 'ok', verdict: 'clear', memoryItemId: mem.item.memoryItemId };
}

// ── "I don't know" → suggest a labeled assumption → ai_assumption memory item (DISC-005) ────────────────
export async function suggestAssumptionForSkip(client: DatabaseClient, params: SuggestAssumptionParams, deps: OrchestrationDeps, options: OrchestrationOptions = {}): Promise<SuggestAssumptionResult> {
  const qa = await getSessionQa(client, { userId: params.userId, accountId: params.accountId, companyId: params.companyId, sessionId: params.sessionId }, options);
  if (qa.status === 'forbidden') return { status: 'forbidden' };
  if (qa.status === 'not_found') return { status: 'not_found' };
  const target = qa.qa.items.find((i) => i.question.questionId === params.questionId);
  if (target === undefined) return { status: 'not_found' };

  const priorAnswers = formatPriorAnswers(qa.qa, params.questionId);
  const request = buildAssumptionRequest({ accountId: params.accountId, companyId: params.companyId, question: target.question.prompt, priorAnswers, ...corr(options) });
  const assumption = resolveAssumption(await deps.gateway(request, corr(options)));
  if (assumption === null) return { status: 'ok', assumption: null, memoryItemId: null };

  // Store the assumption as an ai_assumption (model_generation source — never a user_fact). Audited.
  const mem = await createMemoryItem(client, { userId: params.userId, accountId: params.accountId, companyId: params.companyId, type: 'ai_assumption', content: assumption, sourceType: 'model_generation', sourceRef: `question:${params.questionId}` }, options);
  if (mem.status === 'forbidden') return { status: 'forbidden' };
  if (mem.status !== 'ok') return { status: 'ok', assumption: null, memoryItemId: null };
  return { status: 'ok', assumption, memoryItemId: mem.item.memoryItemId };
}
