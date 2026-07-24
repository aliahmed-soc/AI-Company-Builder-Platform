// @acbp/contracts — model GATEWAY contract (ACBP-P2-003; ADR-011, ADR-019; CDR-026).
//
// This is the INTERNAL gateway seam every product module calls (ADR-011 §5). It sits ABOVE the
// provider-facing `ModelProvider` (adapters/model-provider.ts): product code speaks this request/
// response shape and NEVER touches a provider dialect. Provider selection, primary/fallback policy,
// per-class timeouts, bounded retry, schema-first re-ask, redaction, and usage metering are the
// gateway's job — this contract only names the stable seam + its config vocabulary. Zero-dep leaf:
// no provider SDK types, no DB types, no framework types.
import type { ModelUsage } from '../adapters/model-provider.js';
import type { ErrorCategory } from '../errors.js';

// ---------------------------------------------------------------------------------------------------
// Timeout classes + task classes (config vocabulary — CDR-026; IOQ-13 ratified values).
// ---------------------------------------------------------------------------------------------------

/** How long the caller is willing to wait. Drives the enforced per-call timeout (IOQ-13). */
export type TimeoutClass = 'interactive' | 'generation';

/**
 * What KIND of work the call does. Drives the timeout class + fallback eligibility (ADR-011 §5:
 * "fallback eligibility per task class; quality-bearing generation prefers queueing per NFR-019").
 * Initial vocabulary (CDR-026 §2) — extensible; every class maps to a policy in `TASK_CLASS_POLICY`.
 */
export type TaskClass = 'interactive' | 'extraction' | 'classification' | 'generation';

/** Owner-ratified per-class enforced timeout (IOQ-13; CDR-026 §1). Milliseconds. */
export const TIMEOUT_CLASS_MS: Readonly<Record<TimeoutClass, number>> = Object.freeze({
  interactive: 30_000,
  generation: 120_000,
});

/** Bounded idempotent retry cap for RETRYABLE provider failures (IOQ-13 ≤ 2; ADR-011 "bounded retries"). */
export const MAX_RETRY_ATTEMPTS = 2;

/** Bounded re-ask cap when a structurally-invalid output is returned (ADR-011 "bounded re-ask"). */
export const MAX_REASK_ATTEMPTS = 1;

/** Base backoff (ms) for the bounded exponential retry (NFR-007). Small, deterministic, no jitter here. */
export const RETRY_BACKOFF_BASE_MS = 250;

interface TaskClassPolicy {
  readonly timeoutClass: TimeoutClass;
  /** Quality-bearing generation is fallback-INELIGIBLE — surface/queue honestly, no silent fallback (ADR-019). */
  readonly fallbackEligible: boolean;
}

/** The single source of truth mapping a task class → its timeout class + fallback eligibility (CDR-026 §2). */
export const TASK_CLASS_POLICY: Readonly<Record<TaskClass, TaskClassPolicy>> = Object.freeze({
  interactive: { timeoutClass: 'interactive', fallbackEligible: true },
  extraction: { timeoutClass: 'interactive', fallbackEligible: true },
  classification: { timeoutClass: 'interactive', fallbackEligible: true },
  generation: { timeoutClass: 'generation', fallbackEligible: false },
});

/** The enforced timeout class for a task class. */
export function timeoutClassForTask(taskClass: TaskClass): TimeoutClass {
  return TASK_CLASS_POLICY[taskClass].timeoutClass;
}

/** Whether a task class may transparently fall back to the secondary provider (ADR-019 non-silent-fallback). */
export function isFallbackEligible(taskClass: TaskClass): boolean {
  return TASK_CLASS_POLICY[taskClass].fallbackEligible;
}

/** The enforced timeout (ms) for a task class. */
export function timeoutMsForTask(taskClass: TaskClass): number {
  return TIMEOUT_CLASS_MS[timeoutClassForTask(taskClass)];
}

// ---------------------------------------------------------------------------------------------------
// Normalized error taxonomy (ADR-011 §5 — the EXACT seven categories; the ONLY thing surfaced).
// ---------------------------------------------------------------------------------------------------

/**
 * The normalized model-call error taxonomy (ADR-011 §5). Raw provider exception text NEVER appears —
 * every failure collapses to one of these categories before it is logged, metered, or returned.
 */
export type ModelErrorCategory =
  | 'timeout'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'invalid_output'
  | 'content_refused'
  | 'budget_exceeded'
  | 'internal';

/** Retryable failures — transient, safe to retry the SAME provider (idempotent model call). */
const RETRYABLE_MODEL_ERRORS: ReadonlySet<ModelErrorCategory> = new Set<ModelErrorCategory>([
  'timeout',
  'rate_limited',
  'provider_unavailable',
]);

/** Whether a normalized error is a transient, retry-eligible failure (drives bounded retry + fallback). */
export function isRetryableModelError(category: ModelErrorCategory): boolean {
  return RETRYABLE_MODEL_ERRORS.has(category);
}

/** Map a normalized model error onto the platform's public ErrorCategory (for the HTTP/public envelope). */
export function toErrorCategory(category: ModelErrorCategory): ErrorCategory {
  switch (category) {
    case 'timeout':
    case 'provider_unavailable':
      return 'provider_unavailable';
    case 'rate_limited':
    case 'budget_exceeded':
      return 'limit_exceeded';
    case 'content_refused':
      return 'policy_blocked';
    case 'invalid_output':
    case 'internal':
      return 'internal';
  }
}

// ---------------------------------------------------------------------------------------------------
// The request/response seam (ADR-011 §5 field-for-field).
// ---------------------------------------------------------------------------------------------------

/** One assembled context part (P2-007 builds these; the gateway consumes them opaquely). */
export interface ModelContextPart {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** Optional per-call budget ceiling (ADR-011 `budget`). Cost is integer micro-units — never a float. */
export interface ModelCallBudget {
  readonly maxOutputTokens?: number;
  readonly maxEstimatedCostMicros?: number;
}

/**
 * The internal gateway request (ADR-011 §5). `templateRef`/`contextParts` arrive ALREADY assembled
 * (P2-004/P2-007) — the gateway never builds prompts. `policyContext` feeds the company-policy
 * pre-check hook (caps/tier). Both `companyId` and `accountId` are required: every call meters usage
 * to company AND account (ADR-011). Credentials are resolved server-side — never carried here.
 */
export interface ModelGatewayRequest {
  readonly taskClass: TaskClass;
  readonly templateRef: string;
  readonly contextParts: readonly ModelContextPart[];
  readonly outputSchemaRef?: string;
  readonly budget?: ModelCallBudget;
  readonly timeoutClass: TimeoutClass;
  readonly companyId: string;
  readonly accountId: string;
  readonly correlationId?: string;
  /** Opaque policy inputs (tier/caps) for the pre-check hook. Never provider- or prompt-content. */
  readonly policyContext?: Readonly<Record<string, string | number | boolean>>;
}

export type ModelOutcome = 'ok' | 'error';

/**
 * The internal gateway response (ADR-011 §5). On `ok`, `validatedOutput` is the schema-checked result;
 * on `error`, `errorCategory` is the normalized category (never raw provider text). `provider`/`model`
 * /`modelVersion` are stamped for artifact provenance; `estimatedCostMicros` is integer micro-units.
 */
export interface ModelGatewayResult {
  readonly outcome: ModelOutcome;
  readonly validatedOutput?: unknown;
  readonly errorCategory?: ModelErrorCategory;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion?: string;
  readonly tokenUsage: ModelUsage;
  readonly estimatedCostMicros: number;
  readonly fallbackUsed: boolean;
  readonly latencyMs: number;
  readonly correlationId?: string;
}
