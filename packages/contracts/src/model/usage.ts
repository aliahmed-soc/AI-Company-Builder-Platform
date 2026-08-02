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
  /**
   * WHY the call fell over to the secondary provider (ACBP-P5-009; NFR-019). Present exactly when `fallbackUsed`
   * is true, absent otherwise — the pair can never contradict itself.
   *
   * `fallbackUsed` alone answers *whether*, and canon asks for the **reason**. The difference is operational: an
   * engineer looking at a degraded answer needs to know the primary timed out versus was rate-limited versus was
   * unavailable, because those imply different responses. A boolean collapses all of them into "something happened".
   *
   * It is the NORMALIZED category from the closed set — never raw provider text, which would put an unbounded
   * vendor string into a ledger retained for the billing lifetime.
   */
  readonly fallbackReason?: ModelErrorCategory;
  readonly latencyMs: number;
  readonly correlationId?: string;
  /**
   * Duplicate-suppression key for this DELIVERY of the usage record (ACBP-P6-011; CDR-074 §2/§5). Optional, and
   * NO CALLER SUPPLIES ONE TODAY — deliberately, not by oversight. Today's metering is inline and fail-closed, so
   * a failed write leaves nothing behind and a genuine retry means the model really was called again. The field
   * exists so the mechanism is REACHABLE when usage delivery becomes message-driven (NFR-006, ADR-008).
   *
   * TWO RULES FOR WHOEVER FIRST SUPPLIES ONE, because getting either wrong is a silent billing error:
   *   1. It identifies the CALL, so every re-delivery of that call carries the same value.
   *   2. It must be UNIQUE PER CALL. Deriving it from the call's attributes (provider, model, tokens, cost, even
   *      a timestamp) makes two legitimate identical calls collapse into one — an UNDER-count, and unlike an
   *      over-count nothing downstream will ever contradict it.
   *
   * NOT `correlationId`: one correlation can cover several model calls, so reusing it would suppress every call
   * after the first.
   */
  readonly idempotencyKey?: string;
}
