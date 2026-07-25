// @acbp/core — strategy option generation use case (ACBP-P3-001/P3-002; CDR-034/CDR-035; STRAT-001/002; ADR-011/019).
//
// Generate a set of strategy options from the company's CONFIRMED understanding version. Gated: strategy generation is
// BLOCKED until the owner confirms the understanding (UNDER-003/P2-009 — planning/strategy locked pre-confirm). The
// model call runs BETWEEN scoped operations (never in a held tx): read the confirmed understanding (its own scope) →
// call the P2-003 GATEWAY (injected, provider-neutral; fake in P3-001 — live is the deferred owner gate CDR-026 §0) →
// validate the 16-field standard (ADR-019 no fake precision) → run the STRAT-001 similarity check (P3-002/CDR-035:
// reject near-duplicates; persist ONLY the genuinely-distinct set; real distinct/insufficient_distinct verdict; honest
// fewer-than-three) → persist ONE immutable generation + its distinct options + the `strategy.generated` audit in a
// SINGLE company-scoped transaction (audit-or-nothing). A gateway failure or malformed output persists NOTHING.
import { StrategyRepository, UnderstandingRepository, UnderstandingReviewRepository, writeAuditEvent, type DatabaseClient, type AuditScope, type AuditWriteContext, type StrategyGenerationRow, type StrategyOptionRow } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import {
  strategyGenerated,
  narrowStrategyOutput,
  dedupeByDistinctness,
  isVersionConfirmed,
  isConfirmationEventKind,
  resolveTemplateRef,
  renderTemplateSegments,
  templateRef,
  timeoutClassForTask,
  STRATEGY_OPTIONS_SCHEMA,
  FEWER_REASON_MAX,
  type AuditEvent,
  type ModelContextPart,
  type ModelGatewayRequest,
  type ModelGatewayResult,
  type StrategyGenerationDTO,
  type StrategyOptionDTO,
  type StrategyGenerationOutput,
  type StrategyGenerationStatus,
  type SimilarityCheckResult,
  type StrategyRecommendationDTO,
  type StrategySelectionDTO,
  type DecisionDTO,
} from '@acbp/contracts';
import { toRecommendationDTO } from './strategy-recommendation.js';
import { toSelectionDTO } from './strategy-selection.js';
import type { Logger } from '@acbp/observability';

type AuditWriteFn = (scope: AuditScope, event: AuditEvent, ctx?: AuditWriteContext) => Promise<string>;
export type ModelGateway = (request: ModelGatewayRequest, options?: { readonly correlationId?: string }) => Promise<ModelGatewayResult>;

const UNDERSTANDING_PROMPT_MAX = 12_000;

export interface GenerateStrategyParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}
export interface StrategyGenerationDeps {
  readonly gateway: ModelGateway;
  readonly logger?: Logger;
}
export interface StrategyGenerationOptions {
  readonly correlationId?: string;
  /** TEST SEAM ONLY: override the in-tx audit writer to force a failure (prove persist rolls back). */
  readonly auditWriter?: AuditWriteFn;
  /** TEST SEAM ONLY: run between the model call and the persist transaction (to simulate a concurrent understanding change). */
  readonly beforePersist?: () => Promise<void>;
}

export type GenerateStrategyResult =
  | { readonly status: 'ok'; readonly generation: StrategyGenerationDTO }
  | { readonly status: 'forbidden' }
  | { readonly status: 'no_understanding' }
  | { readonly status: 'not_confirmed' }
  // The understanding changed (corrected/superseded/regenerated) between the read and the persist — the strategy set
  // would be based on an understanding that is no longer the current confirmed version, so nothing is persisted.
  | { readonly status: 'stale_understanding' }
  | { readonly status: 'generation_failed' };

/** Format the confirmed understanding items into the bounded `{{understanding}}` prompt text (class-labeled, no ids). */
export function formatUnderstandingForPrompt(items: readonly { readonly item_class: string; readonly content: string }[]): string {
  if (items.length === 0) return 'No confirmed understanding items.';
  return items.map((i) => `- [${i.item_class}] ${i.content}`).join('\n').slice(0, UNDERSTANDING_PROMPT_MAX);
}

/** Build the strategy-options gateway request (pins the registered template + output schema). */
export function buildStrategyRequest(input: { accountId: string; companyId: string; understanding: string; correlationId?: string }): ModelGatewayRequest {
  const def = resolveTemplateRef('strategy.options@1');
  const contextParts: ModelContextPart[] = renderTemplateSegments(def, { understanding: input.understanding }).map((s) => ({ role: s.role, content: s.text }));
  return {
    taskClass: def.taskClass,
    templateRef: templateRef(def),
    contextParts,
    outputSchemaRef: STRATEGY_OPTIONS_SCHEMA,
    timeoutClass: timeoutClassForTask(def.taskClass),
    companyId: input.companyId,
    accountId: input.accountId,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  };
}

/** Defensively narrow the gateway's already-validated output (no raw re-parse; a corrupted seam value → undefined). */
function validOptions(validatedOutput: unknown): StrategyGenerationOutput | undefined {
  return narrowStrategyOutput(validatedOutput);
}

type PreRead =
  | { readonly kind: 'ready'; readonly documentId: string; readonly version: number; readonly understanding: string }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'no_understanding' }
  | { readonly kind: 'not_confirmed' };

export async function generateStrategyOptions(client: DatabaseClient, params: GenerateStrategyParams, deps: StrategyGenerationDeps, options: StrategyGenerationOptions = {}): Promise<GenerateStrategyResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const optsBase = { ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}), ...(deps.logger !== undefined ? { logger: deps.logger } : {}) };

  // 1. Gate + read the confirmed understanding (own scope; strategy:generate authz). Strategy is BLOCKED pre-confirm.
  const read = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<PreRead> => {
      if (checkAuthorization(role, 'strategy:generate', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { kind: 'forbidden' };
      const docs = new UnderstandingRepository(scope.db);
      const current = await docs.currentDocument(params.companyId);
      if (current === undefined) return { kind: 'no_understanding' };
      const events = await new UnderstandingReviewRepository(scope.db).listConfirmationEvents(current.id);
      const confirmed = isVersionConfirmed(events.filter((e) => isConfirmationEventKind(e.kind)).map((e) => ({ kind: e.kind as 'confirmed' | 'corrected' })));
      if (!confirmed) return { kind: 'not_confirmed' };
      const items = await docs.listItems(current.id);
      return { kind: 'ready', documentId: current.id, version: current.version, understanding: formatUnderstandingForPrompt(items) };
    },
    optsBase,
  );
  if (read.kind !== 'ran') return { status: 'forbidden' };
  const pre = read.value;
  if (pre.kind === 'forbidden') return { status: 'forbidden' };
  if (pre.kind === 'no_understanding') return { status: 'no_understanding' };
  if (pre.kind === 'not_confirmed') return { status: 'not_confirmed' };

  // 2. Call the gateway (external; its own usage-metering tx). Model call BETWEEN scoped operations.
  const request = buildStrategyRequest({ accountId: params.accountId, companyId: params.companyId, understanding: pre.understanding, ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}) });
  const result = await deps.gateway(request, options.correlationId !== undefined ? { correlationId: options.correlationId } : {});

  // 3. A gateway failure OR malformed output persists NOTHING.
  if (result.outcome !== 'ok') return { status: 'generation_failed' };
  const parsed = validOptions(result.validatedOutput);
  if (parsed === undefined) return { status: 'generation_failed' };

  // The STRAT-001 similarity check (ACBP-P3-002; CDR-035): reject near-duplicates (cosmetic variants) — only the
  // genuinely-distinct set (differing on customer/offer/business_model) is persisted. The honest outcome + verdict
  // follow from the DISTINCT count, not the raw model count.
  const distinctness = dedupeByDistinctness(parsed.options);
  const distinctOptions = distinctness.distinct;
  const similarity: SimilarityCheckResult = distinctness.result;
  const status: StrategyGenerationStatus = similarity === 'distinct' ? 'complete' : 'fewer_than_three';
  const fewerReason = status === 'fewer_than_three' ? honestFewerReason(parsed.fewerReason, distinctOptions.length, distinctness.duplicatesRejected) : null;

  if (options.beforePersist !== undefined) await options.beforePersist();

  // 4. Persist the generation + options + audit in ONE company-scoped transaction (audit-or-nothing). The confirm gate
  //    is RE-VERIFIED here (the understanding may have been corrected/superseded/regenerated during the model call) —
  //    a stale generation is never written (optimistic concurrency, mirroring understanding review's version guard).
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<GenerateStrategyResult> => {
      if (checkAuthorization(role, 'strategy:generate', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { status: 'forbidden' };
      const docs = new UnderstandingRepository(scope.db);
      const current = await docs.currentDocument(params.companyId);
      if (current === undefined || current.id !== pre.documentId || current.version !== pre.version) return { status: 'stale_understanding' };
      const events = await new UnderstandingReviewRepository(scope.db).listConfirmationEvents(current.id);
      if (!isVersionConfirmed(events.filter((e) => isConfirmationEventKind(e.kind)).map((e) => ({ kind: e.kind as 'confirmed' | 'corrected' })))) return { status: 'stale_understanding' };
      const repo = new StrategyRepository(scope.db);
      const generation = await repo.insertGeneration({
        accountId: params.accountId,
        companyId: params.companyId,
        understandingDocumentId: pre.documentId,
        understandingVersion: pre.version,
        status,
        optionCount: distinctOptions.length,
        fewerReason,
        similarityCheckResult: similarity,
        modelFlaggedPartial: parsed.partial,
        createdByUserId: params.userId,
      });
      // Persist ONLY the distinct set, re-ordinaled 0..n-1 (near-duplicates are rejected, not stored — STRAT-001).
      const optionRows: StrategyOptionRow[] = [];
      for (let i = 0; i < distinctOptions.length; i += 1) {
        optionRows.push(await repo.insertOption({ accountId: params.accountId, companyId: params.companyId, generationId: generation.id, ordinal: i, fields: distinctOptions[i]! }));
      }
      // strategy.generated in the SAME transaction — an audit failure rolls the whole generation+options back.
      await audit(scope, strategyGenerated({ generationId: generation.id, understandingVersion: pre.version, optionCount: distinctOptions.length, similarityCheckResult: similarity }), options.correlationId !== undefined ? { correlationId: options.correlationId } : {});
      deps.logger?.info('strategy.generated', { metadata: { accountId: params.accountId, companyId: params.companyId, understandingVersion: pre.version, optionCount: distinctOptions.length, similarityCheckResult: similarity, status } });
      return { status: 'ok', generation: toGenerationDTO(generation, optionRows) };
    },
    optsBase,
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── reads (strategy:read) ────────────────────────────────────────────────────────────────────────────────
export interface StrategyReadParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}
export type LatestStrategyResult = { readonly status: 'ok'; readonly generation: StrategyGenerationDTO | null } | { readonly status: 'forbidden' };

/** The company's CURRENT (latest) strategy generation + its options, or null when none exists (owner+viewer). */
export async function getLatestStrategyGeneration(client: DatabaseClient, params: StrategyReadParams, options: StrategyGenerationOptions = {}): Promise<LatestStrategyResult> {
  const optsBase: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) optsBase.correlationId = options.correlationId;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<LatestStrategyResult> => {
      if (checkAuthorization(role, 'strategy:read', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { status: 'forbidden' };
      const repo = new StrategyRepository(scope.db);
      const generation = await repo.latestGeneration(params.companyId);
      if (generation === undefined) return { status: 'ok', generation: null };
      const optionRows = await repo.listOptions(generation.id);
      // Surface the latest advisory recommendation for this generation (P3-003), if any (latest-wins).
      const recRow = await repo.latestRecommendation(generation.id);
      const recDTO = recRow === undefined ? null : toRecommendationDTO(recRow, optionRows.find((o) => o.id === recRow.recommended_option_id)?.ordinal ?? -1);
      // Surface the latest owner selection for this generation (P3-004), if any (latest-wins).
      const selRow = await repo.latestSelection(generation.id);
      const selDTO = selRow === undefined ? null : toSelectionDTO(selRow);
      return { status: 'ok', generation: toGenerationDTO(generation, optionRows, recDTO, selDTO) };
    },
    optsBase,
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The honest fewer-than-three reason (STRAT-001 "stated honestly with reasons rather than padded"). ALWAYS returns a
 * factual, non-fabricated reason (ADR-019) — never null — so a `fewer_than_three` generation is never unexplained.
 * Prefers the model's own reason; else, when near-duplicates collapsed the set, states how many genuinely-distinct
 * options remain + how many cosmetic variants were rejected; else (the model simply produced fewer than three) states
 * that plainly. Only fixed axis names + counts are used — no option content.
 */
function honestFewerReason(modelReason: string | null, distinctCount: number, duplicatesRejected: number): string {
  if (modelReason !== null) return modelReason;
  const optWord = distinctCount === 1 ? 'option' : 'options';
  if (duplicatesRejected > 0) {
    const dupWord = duplicatesRejected === 1 ? 'near-duplicate' : 'near-duplicates';
    return `${distinctCount} genuinely distinct ${optWord}; ${duplicatesRejected} ${dupWord} on customer/offer/business_model were rejected.`.slice(0, FEWER_REASON_MAX);
  }
  return `The model produced only ${distinctCount} genuinely distinct ${optWord} for this understanding.`.slice(0, FEWER_REASON_MAX);
}

function toGenerationDTO(row: StrategyGenerationRow, options: readonly StrategyOptionRow[], recommendation: StrategyRecommendationDTO | null = null, selection: StrategySelectionDTO | null = null, decision: DecisionDTO | null = null): StrategyGenerationDTO {
  return {
    generationId: row.id,
    companyId: row.company_id,
    understandingVersion: row.understanding_version,
    status: row.status as StrategyGenerationStatus,
    optionCount: row.option_count,
    fewerReason: row.fewer_reason,
    similarityCheckResult: row.similarity_check_result as SimilarityCheckResult,
    modelFlaggedPartial: row.model_flagged_partial,
    options: options.map(toOptionDTO),
    recommendation,
    // The owner's decision is surfaced by the P3-004 read path; a bare generation DTO carries none.
    selection,
    // The immutable decision RECORD is surfaced by the P3-005 read path; a bare generation DTO carries none.
    decision,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
function toOptionDTO(row: StrategyOptionRow): StrategyOptionDTO {
  return { optionId: row.id, ordinal: row.ordinal, fields: row.fields as StrategyOptionDTO['fields'] };
}
