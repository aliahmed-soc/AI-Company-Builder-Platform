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
  /**
   * Duplicate-suppression key for this DELIVERY of the usage record (ACBP-P6-011; CDR-074 §2; trust-critical
   * #12). Optional: absent means no suppression, and two keyless writes are never duplicates of each other.
   *
   * It identifies the CALL, so a re-delivered write of the same call carries the same key. It must NOT be
   * derived from the call's attributes — two distinct calls with identical provider, model, tokens and cost in
   * the same instant are legitimate, and collapsing them would UNDER-count.
   */
  readonly idempotencyKey?: string | null;
}

/**
 * The outcome of appending a usage event.
 *
 * TWO OUTCOMES, NOT A ROW OR A THROW, and the distinction is what makes suppression safe. Metering is
 * FAIL-CLOSED (CDR-026 §5): a write failure throws and the model output is withheld. If a duplicate surfaced as
 * a failure, a re-delivered write would withhold an output the customer has already been charged for — the
 * suppression feature would create the harm it exists to prevent. So `suppressed` is a SUCCESS.
 */
export type UsageEventInsertResult =
  | { readonly status: 'inserted'; readonly row: UsageEventRow }
  /** A row with this `(company_id, idempotency_key)` already exists. Nothing was written; the ledger is correct. */
  | { readonly status: 'suppressed' };

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
  async insert(input: NewUsageEventInput): Promise<UsageEventInsertResult> {
    const key = (input.idempotencyKey ?? '').trim() === '' ? null : (input.idempotencyKey ?? null);
    const row = await this.#db
      .insertInto('usage_events')
      .values({
        idempotency_key: key,
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
      // SCOPED TO THE EXACT PARTIAL INDEX, never a blanket conflict handler. `(company_id, idempotency_key)
      // where idempotency_key is not null` is the only collision that means "already delivered"; swallowing any
      // other constraint violation here would turn a genuine data defect into a silent no-op on a billing
      // ledger. A keyless row matches no index predicate, so it is inserted unconditionally.
      .onConflict((oc) => oc.columns(['company_id', 'idempotency_key']).where('idempotency_key', 'is not', null).doNothing())
      // `executeTakeFirst`, not `...OrThrow`: DO NOTHING returns ZERO rows on suppression, and that is the
      // success path (see UsageEventInsertResult).
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? { status: 'suppressed' } : { status: 'inserted', row };
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
