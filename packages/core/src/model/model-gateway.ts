// @acbp/core — the provider-neutral MODEL GATEWAY (ACBP-P2-003; ADR-011 §5; ADR-019; CDR-026; NFR-019/007/009;
// USAGE-001).
//
// The single in-process seam every product module calls to run a model call. Product code speaks the
// `ModelGatewayRequest`/`ModelGatewayResult` contract and NEVER touches a provider dialect. This module owns the
// 13 gateway capabilities: company-policy pre-check (caps/tier), server-side provider/credential resolution
// (injected — never in the request), per-class timeout, bounded idempotent retry, schema-first bounded re-ask,
// fallback eligibility per task class (NO silent fallback for quality-bearing generation), a NORMALIZED error
// taxonomy (raw provider text never logged/returned), model-version stamping, redacted logging, and APPEND-ONLY
// usage metering with FAIL-CLOSED behaviour (a metering-write failure aborts the operation — no un-metered
// output is ever surfaced as success).
//
// It imports NO provider SDK and NO database module: providers + the usage sink are injected, so the gateway
// stays provider-neutral (the fake provider + the RLS-scoped usage write are wired by the composition layer).
import {
  MAX_REASK_ATTEMPTS,
  MAX_RETRY_ATTEMPTS,
  RETRY_BACKOFF_BASE_MS,
  TIMEOUT_CLASS_MS,
  isFallbackEligible,
  isRetryableModelError,
  normalizeError,
  ErrorCodes,
  isPlatformError,
  PlatformError,
  type ModelErrorCategory,
  type ModelGatewayRequest,
  type ModelGatewayResult,
  type ModelId,
  type ModelMessage,
  type ModelProvider,
  type ModelUsage,
  type NewModelCallUsageEvent,
  type TimeoutClass,
} from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

/** A fully-resolved provider slot: the config-bound model + credentials are already resolved SERVER-SIDE. */
export interface ResolvedProvider {
  /** Provider family name — bounded, non-secret (never a credential). */
  readonly name: string;
  readonly modelId: ModelId;
  readonly modelVersion?: string;
  readonly provider: ModelProvider;
}

export interface OutputValidationOk {
  readonly ok: true;
  readonly value: unknown;
}
export interface OutputValidationErr {
  readonly ok: false;
}
export type OutputValidation = OutputValidationOk | OutputValidationErr;

export interface CostInput {
  readonly providerName: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The caps/tier pre-check decision (ADR-011 company-policy pre-check). `allowed:false` → `budget_exceeded`. */
export interface PolicyDecision {
  readonly allowed: boolean;
}

/** Overridable gateway config. Defaults come from the owner-ratified contract constants (IOQ-13; CDR-026 §1). */
export interface GatewayConfig {
  readonly timeoutMs?: Partial<Record<TimeoutClass, number>>;
  readonly maxRetries?: number;
  readonly maxReask?: number;
  readonly backoffBaseMs?: number;
}

export interface ModelGatewayDeps {
  readonly primary: ResolvedProvider;
  readonly fallback?: ResolvedProvider;
  /**
   * FAIL-CLOSED usage sink (CDR-026 §5). Writes the append-only usage event; the composition runs it under the
   * request's company scope. If it throws, `callModel` propagates a sanitized error — the output is NOT returned.
   */
  readonly recordUsage: (event: NewModelCallUsageEvent) => Promise<void>;
  /** Provider-cost estimate → integer micro-units (ADR-013 estimate lane). */
  readonly estimateCost: (input: CostInput) => number;
  /** Schema-first structured-output validation (drives bounded re-ask). Omit → the raw output is accepted. */
  readonly validateOutput?: (schemaRef: string, output: string) => OutputValidation;
  /** Company-policy pre-check (caps/tier). Omit → always allowed. */
  readonly policyPrecheck?: (request: ModelGatewayRequest) => PolicyDecision | Promise<PolicyDecision>;
  readonly logger?: Logger;
  readonly config?: GatewayConfig;
  /** Injected backoff (tests → no-op). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected clock for latency (tests → deterministic). */
  readonly now?: () => number;
}

interface ResolvedConfig {
  readonly timeoutMs: Record<TimeoutClass, number>;
  readonly maxRetries: number;
  readonly maxReask: number;
  readonly backoffBaseMs: number;
}

type Attempt =
  | { readonly kind: 'success'; readonly validated: unknown; readonly usage: ModelUsage; readonly modelVersion?: string }
  | { readonly kind: 'error'; readonly category: ModelErrorCategory };

function resolveConfig(config: GatewayConfig | undefined): ResolvedConfig {
  return {
    timeoutMs: {
      interactive: config?.timeoutMs?.interactive ?? TIMEOUT_CLASS_MS.interactive,
      generation: config?.timeoutMs?.generation ?? TIMEOUT_CLASS_MS.generation,
    },
    maxRetries: config?.maxRetries ?? MAX_RETRY_ATTEMPTS,
    maxReask: config?.maxReask ?? MAX_REASK_ATTEMPTS,
    backoffBaseMs: config?.backoffBaseMs ?? RETRY_BACKOFF_BASE_MS,
  };
}

/** Normalize any thrown provider value into the seven-value taxonomy. Raw text is NEVER inspected for logging. */
function classifyProviderError(err: unknown): ModelErrorCategory {
  if (isPlatformError(err)) {
    if (err.code === ErrorCodes.DEPENDENCY_TIMEOUT) return 'timeout';
    if (err.category === 'limit_exceeded' || err.code === ErrorCodes.RATE_LIMIT_EXCEEDED) return 'rate_limited';
    if (err.category === 'provider_unavailable') return 'provider_unavailable';
    if (err.category === 'policy_blocked') return 'content_refused';
  }
  return 'internal';
}

/** Race the provider call against the class timeout; on expiry, abort the provider and raise a timeout error. */
async function withTimeout(run: (signal: AbortSignal) => Promise<Attempt>, timeoutMs: number): Promise<Attempt> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PlatformError('provider_unavailable', { code: ErrorCodes.DEPENDENCY_TIMEOUT, internalMessage: 'gateway timeout' }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One provider call: generate → map finish status → schema-validate. Returns a normalized Attempt (never throws). */
async function singleCall(rp: ResolvedProvider, request: ModelGatewayRequest, messages: readonly ModelMessage[], timeoutMs: number, deps: ModelGatewayDeps): Promise<Attempt> {
  try {
    return await withTimeout(async (signal): Promise<Attempt> => {
      const resp = await rp.provider.generate(
        {
          modelId: rp.modelId,
          messages,
          ...(request.budget?.maxOutputTokens !== undefined ? { maxOutputTokens: request.budget.maxOutputTokens } : {}),
          ...(request.outputSchemaRef !== undefined ? { outputSchemaRef: request.outputSchemaRef } : {}),
        },
        { signal, timeoutMs },
      );
      if (resp.finishStatus === 'refused' || resp.finishStatus === 'content_filtered') return { kind: 'error', category: 'content_refused' };
      if (resp.finishStatus === 'error') return { kind: 'error', category: 'internal' };
      // completed | length → validate the structured output if a schema was requested.
      const modelVersion = resp.modelVersion ?? rp.modelVersion;
      if (request.outputSchemaRef !== undefined && deps.validateOutput !== undefined) {
        const v = deps.validateOutput(request.outputSchemaRef, resp.output);
        if (!v.ok) return { kind: 'error', category: 'invalid_output' };
        return { kind: 'success', validated: v.value, usage: resp.usage, ...(modelVersion !== undefined ? { modelVersion } : {}) };
      }
      return { kind: 'success', validated: resp.output, usage: resp.usage, ...(modelVersion !== undefined ? { modelVersion } : {}) };
    }, timeoutMs);
  } catch (err) {
    return { kind: 'error', category: classifyProviderError(err) };
  }
}

/** One provider slot WITH bounded retry (retryable infra errors) + bounded re-ask (invalid_output). */
async function runProvider(rp: ResolvedProvider, request: ModelGatewayRequest, messages: readonly ModelMessage[], cfg: ResolvedConfig, deps: ModelGatewayDeps): Promise<Attempt> {
  const timeoutMs = cfg.timeoutMs[request.timeoutClass];
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let retriesLeft = cfg.maxRetries;
  let reasksLeft = cfg.maxReask;
  for (let attemptNo = 0; ; attemptNo += 1) {
    const attempt = await singleCall(rp, request, messages, timeoutMs, deps);
    if (attempt.kind === 'success') return attempt;
    // A structurally-invalid output is re-asked (schema-first), not retried.
    if (attempt.category === 'invalid_output' && reasksLeft > 0) {
      reasksLeft -= 1;
      continue;
    }
    // Transient infra failures are retried on the SAME provider with bounded exponential backoff.
    if (isRetryableModelError(attempt.category) && retriesLeft > 0) {
      retriesLeft -= 1;
      await sleep(cfg.backoffBaseMs * 2 ** attemptNo);
      continue;
    }
    return attempt; // terminal for this provider
  }
}

function composeModel(rp: ResolvedProvider, respModelVersion: string | undefined): string {
  const version = respModelVersion ?? rp.modelVersion;
  const full = version !== undefined ? `${String(rp.modelId)}@${version}` : String(rp.modelId);
  return full.slice(0, 128); // bounded to the usage_events column width
}

/**
 * Run one model call through the gateway. Always returns a `ModelGatewayResult` for model outcomes (including
 * normalized errors); it THROWS only when fail-closed metering cannot record the call — in which case the output
 * is deliberately withheld (the caller must treat it as a failure).
 */
export async function callModel(deps: ModelGatewayDeps, request: ModelGatewayRequest): Promise<ModelGatewayResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const cfg = resolveConfig(deps.config);
  const correlationId = request.correlationId;

  // Company-policy pre-check (caps/tier). A block short-circuits BEFORE any provider call — nothing is consumed,
  // so no usage event is written (usage records model CALLS; a caps block is not a call — CDR-026 §4).
  if (deps.policyPrecheck !== undefined) {
    const decision = await deps.policyPrecheck(request);
    if (!decision.allowed) {
      deps.logger?.info('model.call_blocked', { metadata: redactedMeta(deps.primary.name, composeModel(deps.primary, undefined), request.taskClass, 'error', 'budget_exceeded', false, Math.max(0, now() - started), correlationId) });
      return errorResult('budget_exceeded', deps.primary, false, Math.max(0, now() - started), correlationId);
    }
  }

  const messages: ModelMessage[] = request.contextParts.map((p) => ({ role: p.role, content: p.content }));

  // Primary attempts (bounded retry + re-ask). On a retryable exhaustion, a fallback-ELIGIBLE task class may fall
  // over to the secondary provider (quality-bearing generation is ineligible — no silent fallback, ADR-019).
  let usedProvider = deps.primary;
  let fallbackUsed = false;
  let attempt = await runProvider(deps.primary, request, messages, cfg, deps);
  if (attempt.kind === 'error' && isRetryableModelError(attempt.category) && isFallbackEligible(request.taskClass) && deps.fallback !== undefined) {
    fallbackUsed = true;
    usedProvider = deps.fallback;
    attempt = await runProvider(deps.fallback, request, messages, cfg, deps);
  }

  const latencyMs = Math.max(0, now() - started);
  const model = composeModel(usedProvider, attempt.kind === 'success' ? attempt.modelVersion : undefined);
  const usage: ModelUsage = attempt.kind === 'success' ? attempt.usage : { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const outcome = attempt.kind === 'success' ? 'ok' : 'error';
  const errorCategory = attempt.kind === 'error' ? attempt.category : undefined;
  const estimatedCostMicros = deps.estimateCost({ providerName: usedProvider.name, model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });

  // FAIL-CLOSED metering: append the usage event; if the write fails, the operation fails (output withheld).
  const event: NewModelCallUsageEvent = {
    kind: 'model_call',
    accountId: request.accountId,
    companyId: request.companyId,
    provider: usedProvider.name,
    model,
    taskClass: request.taskClass,
    outcome,
    ...(errorCategory !== undefined ? { errorCategory } : {}),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCostMicros,
    fallbackUsed,
    latencyMs,
    ...(correlationId !== undefined ? { correlationId } : {}),
  };
  try {
    await deps.recordUsage(event);
  } catch (err) {
    // Redacted: never log the raw DB error; surface a sanitized internal error and withhold the output.
    deps.logger?.error('model.metering_failed', { metadata: redactedMeta(usedProvider.name, model, request.taskClass, outcome, errorCategory, fallbackUsed, latencyMs, correlationId) });
    throw normalizeError(err, correlationId !== undefined ? { correlationId } : {});
  }

  deps.logger?.info('model.call_completed', { metadata: redactedMeta(usedProvider.name, model, request.taskClass, outcome, errorCategory, fallbackUsed, latencyMs, correlationId) });

  const modelVersion = attempt.kind === 'success' ? attempt.modelVersion ?? usedProvider.modelVersion : usedProvider.modelVersion;
  return {
    outcome,
    ...(attempt.kind === 'success' ? { validatedOutput: attempt.validated } : {}),
    ...(errorCategory !== undefined ? { errorCategory } : {}),
    provider: usedProvider.name,
    model,
    ...(modelVersion !== undefined ? { modelVersion } : {}),
    tokenUsage: usage,
    estimatedCostMicros,
    fallbackUsed,
    latencyMs,
    ...(correlationId !== undefined ? { correlationId } : {}),
  };
}

/** Bounded, non-secret log metadata — NEVER prompt/response content, NEVER a raw provider error. */
function redactedMeta(provider: string, model: string, taskClass: string, outcome: string, errorCategory: string | undefined, fallbackUsed: boolean, latencyMs: number, correlationId: string | undefined): Record<string, string | number | boolean> {
  return {
    provider,
    model,
    taskClass,
    outcome,
    ...(errorCategory !== undefined ? { errorCategory } : {}),
    fallbackUsed,
    latencyMs,
    ...(correlationId !== undefined ? { correlationId } : {}),
  };
}

function errorResult(category: ModelErrorCategory, rp: ResolvedProvider, fallbackUsed: boolean, latencyMs: number, correlationId: string | undefined): ModelGatewayResult {
  return {
    outcome: 'error',
    errorCategory: category,
    provider: rp.name,
    model: composeModel(rp, undefined),
    ...(rp.modelVersion !== undefined ? { modelVersion: rp.modelVersion } : {}),
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    estimatedCostMicros: 0,
    fallbackUsed,
    latencyMs,
    ...(correlationId !== undefined ? { correlationId } : {}),
  };
}
