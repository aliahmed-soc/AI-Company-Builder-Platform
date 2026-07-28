// @acbp/database — append-only usage-event repository (ACBP-P2-003; CDR-026 §5/§6; ADR-011/ADR-013;
// USAGE-001, invariant 9).
//
// Operates on the append-only `usage_events` rows — the durable model-call usage source record. Takes a
// plain executor and relies on the caller to run it under the correct COMPANY scope (the dual-keyed
// policies deny anything else); the composition writes it in its OWN short tenant transaction AFTER the
// (external) model call (fail-closed metering — a write failure throws and the output is withheld). Kysely
// parameterized queries only; no raw SQL interpolation. There is deliberately NO
// update/delete method — the ledger is immutable (a correction is a new row).
import type { Kysely } from 'kysely';
import type { DatabaseSchema, UsageEventRow } from './schema.js';

export type UsageEventExecutor = Kysely<DatabaseSchema>;

/**
 * The fields a caller supplies to append a usage event. Identity (account/company) + the model-call
 * metadata are all supplied by the gateway; server defaults fill `id`/`kind`/`created_at`. Money is
 * integer micro-units; `errorCategory` is non-null iff `outcome === 'error'` (the table's pairing CHECK
 * enforces this — the gateway keeps them consistent).
 */
export interface NewUsageEventInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly provider: string;
  readonly model: string;
  readonly taskClass: string;
  readonly outcome: string;
  readonly errorCategory: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostMicros: number;
  readonly fallbackUsed: boolean;
  /** WHY the fallover happened (ACBP-P5-009). Null unless fallbackUsed -- a reason never appears without one. */
  readonly fallbackReason: string | null;
  readonly latencyMs: number;
  readonly correlationId: string | null;
  /**
   * The worker run this call belongs to (ACBP-P5-014). OPTIONAL and usually absent: the gateway's callers today are
   * planning and strategy use cases, none of which execute inside a worker run. The column and this field exist so
   * the link is writable the moment a worker actually calls a model, which is P5-006/007/008's wiring.
   */
  readonly workerRunId?: string | null;
}

/** Bounded list options. `limit` is clamped by the caller/use case. */
export interface ListUsageEventsOptions {
  readonly limit: number;
}

export class UsageEventRepository {
  readonly #db: UsageEventExecutor;
  constructor(db: UsageEventExecutor) {
    this.#db = db;
  }

  /**
   * Append one usage event (`kind = 'model_call'`). The outcome/error pairing, closed enums, non-negative
   * counters, and bounded lengths are enforced by the table; the gateway builds a consistent row. Returns
   * the server-generated row.
   */
  insert(input: NewUsageEventInput): Promise<UsageEventRow> {
    return this.#db
      .insertInto('usage_events')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        kind: 'model_call',
        provider: input.provider,
        model: input.model,
        task_class: input.taskClass,
        outcome: input.outcome,
        error_category: input.errorCategory,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        estimated_cost_micros: input.estimatedCostMicros,
        fallback_used: input.fallbackUsed, fallback_reason: input.fallbackReason,
        latency_ms: input.latencyMs,
        correlation_id: input.correlationId,
        worker_run_id: input.workerRunId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * The company's usage events (RLS-confined), newest first with a deterministic total order
   * `(created_at desc, id desc)`, bounded by `limit`. Reads only — rollup/aggregation is P5-014/P6-009.
   */
  list(options: ListUsageEventsOptions): Promise<UsageEventRow[]> {
    return this.#db
      .selectFrom('usage_events')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(options.limit)
      .execute();
  }
}
