// @acbp/contracts — usage-event contract (ACBP-P2-003; ADR-011, ADR-013; USAGE-001; CDR-026 §5).
//
// The provider-neutral shape of the APPEND-ONLY usage source record every model call emits
// (`model.call_completed`; EVENT-CATALOG → Usage ledger). This is the durable, immutable record of a
// metered call — it carries bounded metadata only: NO prompt/response content, NO secrets. The row's
// physical shape lives in @acbp/database (migration 0017 `usage_events`); this is the semantic seam.
//
// `estimatedCost` is the PROVIDER-cost estimate (micro-units), NOT a billable/credit mapping — the
// five-number separation (ADR-013): credits/reservation/rollup are P5-014/P6-009 (deferred).
import type { TaskClass, ModelErrorCategory, ModelOutcome } from './gateway.js';

/** What kind of usage a row records. Model calls are the only kind in v1; extensible (tool/worker later). */
export type UsageEventKind = 'model_call';

/**
 * The bounded metadata a model call contributes to the usage ledger. Money is integer micro-units
 * (never a float). Token counts are non-negative integers. NOTHING here is prompt/response content or
 * a secret — the usage record is safe to retain for the billing lifetime (CDR-026 §6).
 */
export interface NewModelCallUsageEvent {
  readonly kind: 'model_call';
  readonly accountId: string;
  readonly companyId: string;
  /** Provider family name (e.g. the configured primary/fallback). Bounded, non-secret. */
  readonly provider: string;
  /** Resolved model identifier, `model@version`. Bounded, non-secret. */
  readonly model: string;
  readonly taskClass: TaskClass;
  readonly outcome: ModelOutcome;
  /** Present only when `outcome === 'error'` — the normalized category, never raw provider text. */
  readonly errorCategory?: ModelErrorCategory;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Provider-cost estimate in integer micro-units (ADR-013 estimate lane — not billable credits). */
  readonly estimatedCostMicros: number;
  readonly fallbackUsed: boolean;
  readonly latencyMs: number;
  readonly correlationId?: string;
}
