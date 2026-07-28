// @acbp/core — the strategy worker (ACBP-P5-007; CDR-062; WORK-003; STRAT-002; ADR-012/019).
//
// The chain is shorter than research's, and the difference is the point: this worker reads only INTERNAL material
// (`memory_read`, `artifact_write` — the backlog's "Internal tools only"). It never touches untrusted external
// content, so there is no fetch, no injection screen, and no retrieved-source certification. That absence is a
// property worth stating rather than an omission to notice later.
//
//   authorize → gateway → parse → EITHER persist a comparison OR return a specific request
//
// THE TWO OUTCOMES ARE NOT SUCCESS AND FAILURE. A specific request is a complete, expected result: the founder gets
// exactly what the worker needs and why. What is forbidden is the third thing — padding a comparison the input does
// not support, or shrugging without asking — and `parseComparisonOutput` is what makes both unrepresentable.
//
// A REQUEST PERSISTS NO ARTIFACT. An artifact is a produced document; a question is not one, and writing it as an
// artifact would put a request for information into the founder's document library as though it were work product.
import type { DatabaseClient } from '@acbp/database';
import {
  COMPARISON_SCHEMA,
  parseComparisonOutput,
  renderComparisonMarkdown,
  renderTemplateSegments,
  resolveTemplateRef,
  templateRef,
  timeoutClassForTask,
  type ComparisonOutcome,
  type ComparisonRefusal,
  type InputRequest,
  type ModelContextPart,
  type ModelGatewayRequest,
  type ObjectStorage,
} from '@acbp/contracts';
import { persistArtifact, type ArtifactDTO } from '../artifacts/persist.js';
import type { ResearchModelGateway } from './research.js';
import type { Logger } from '@acbp/observability';

/** Bound on the understanding text handed to one prompt. */
const UNDERSTANDING_PROMPT_MAX = 12_000;

export interface StrategyWorkerDeps {
  readonly gateway: ResearchModelGateway;
  readonly storage: ObjectStorage;
  readonly logger?: Logger;
}

export interface RunComparisonParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly runId: string;
  /** What the founder asked to have compared. */
  readonly question: string;
  /** The confirmed understanding, already formatted by the caller (this worker does not read the DB for it). */
  readonly understanding: string;
  readonly workerVersion: number;
  readonly modelVersion: string;
}

export interface RunComparisonOptions {
  readonly correlationId?: string;
}

export type RunComparisonResult =
  | { readonly status: 'ok'; readonly artifact: ArtifactDTO; readonly modelsCompared: number }
  /** A COMPLETE outcome, not a failure: the worker needs specific things and has said exactly which. */
  | { readonly status: 'needs_input'; readonly missing: readonly InputRequest[] }
  | { readonly status: 'blank_question' }
  | { readonly status: 'generation_failed' }
  /** The model's output was neither a real comparison nor a specific request. */
  | { readonly status: 'unusable_output'; readonly reason: ComparisonRefusal; readonly index: number | null }
  | { readonly status: 'persist_failed'; readonly reason: string };

/** Build the comparison gateway request (pins the registered template + output schema). */
export function buildComparisonRequest(input: { accountId: string; companyId: string; question: string; understanding: string; correlationId?: string }): ModelGatewayRequest {
  const def = resolveTemplateRef('strategy.comparison@1');
  const contextParts: ModelContextPart[] = renderTemplateSegments(def, {
    question: input.question,
    understanding: input.understanding.slice(0, UNDERSTANDING_PROMPT_MAX),
  }).map((s) => ({ role: s.role, content: s.text }));
  return {
    taskClass: def.taskClass,
    templateRef: templateRef(def),
    contextParts,
    outputSchemaRef: COMPARISON_SCHEMA,
    timeoutClass: timeoutClassForTask(def.taskClass),
    companyId: input.companyId,
    accountId: input.accountId,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  };
}

/**
 * Defensively re-narrow the gateway's already-validated output.
 *
 * The value crosses a seam as `unknown`, and "something upstream said it validated this" is not a reason to trust a
 * corrupted value. Re-parsing costs nothing and turns a would-be `TypeError` in the persist path into a typed refusal.
 */
export function narrowComparisonOutcome(validatedOutput: unknown): ComparisonOutcome | undefined {
  const parsed = parseComparisonOutput(validatedOutput);
  return parsed.ok ? parsed.outcome : undefined;
}

export async function runStrategyComparison(client: DatabaseClient, params: RunComparisonParams, deps: StrategyWorkerDeps, options: RunComparisonOptions = {}): Promise<RunComparisonResult> {
  if (typeof params.question !== 'string' || params.question.trim() === '') return { status: 'blank_question' };

  const request = buildComparisonRequest({
    accountId: params.accountId,
    companyId: params.companyId,
    question: params.question,
    understanding: params.understanding,
    ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
  });
  const result = await deps.gateway(request, options.correlationId !== undefined ? { correlationId: options.correlationId } : {});
  if (result.outcome !== 'ok') return { status: 'generation_failed' };

  const outcome = narrowComparisonOutcome(result.validatedOutput);
  if (outcome === undefined) {
    // Re-parse the raw value once more to report WHY, so a caller failing the task has an honest category rather
    // than "something was wrong with the output".
    const reparsed = parseComparisonOutput(result.validatedOutput);
    return { status: 'unusable_output', reason: reparsed.ok ? 'unknown_shape' : reparsed.reason, index: reparsed.ok ? null : reparsed.index };
  }

  // THE ASK PATH. No artifact: a question is not a produced document, and filing it as one would put a request for
  // information into the founder's library alongside their actual work product.
  if (outcome.kind === 'insufficient_input') return { status: 'needs_input', missing: outcome.missing };

  const persisted = await persistArtifact(
    client,
    deps.storage,
    {
      userId: params.userId,
      accountId: params.accountId,
      companyId: params.companyId,
      runId: params.runId,
      workerId: 'strategy',
      workerVersion: params.workerVersion,
      modelVersion: params.modelVersion,
      title: params.question.slice(0, 200),
      format: 'markdown',
      content: renderComparisonMarkdown(params.question.slice(0, 200), outcome.models),
    },
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );
  if (persisted.status !== 'ok') return { status: 'persist_failed', reason: persisted.status };
  return { status: 'ok', artifact: persisted.artifact, modelsCompared: outcome.models.length };
}
