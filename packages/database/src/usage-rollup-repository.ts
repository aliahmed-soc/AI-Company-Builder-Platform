// @acbp/database — account usage rollups and compensating corrections (ACBP-P6-009; CDR-073; USAGE-001 amended;
// ADR-013; trust-critical #13/#14).
//
// Two repositories over migration 0051's tables, plus the aggregation reads the rebuild folds over.
//
// SCOPE EXPECTATIONS, because they differ per method and getting one wrong is silent rather than loud:
//   - `AccountUsageRollupRepository.find/upsert` run under EITHER an AccountScope or a CompanyScope. The policies
//     are account-keyed (CDR-073 §1-G2) and a company session sets `app.current_account` too, so the rebuild can
//     write the rollup while still elevated into the last company it summed.
//   - `sumCompanyUsage` / `sumCompanyCorrections` run under a COMPANY scope and read exactly that company's
//     slice: `usage_events` is dual-keyed, so the caller must have elevated first. They take no company id
//     BECAUSE the scope is what confines them — passing one would invite a caller to believe it filtered.
//
// Kysely parameterized queries only; no raw SQL interpolation.
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema, AccountUsageRollupRow, UsageCorrectionRow } from './schema.js';

export type UsageRollupExecutor = Kysely<DatabaseSchema>;

/**
 * Lane-keyed figures as plain JS numbers. Structurally identical to `@acbp/contracts`' `RollupFigures` and
 * deliberately NOT imported from it: `@acbp/database` is provider-neutral and does not depend on the contracts
 * package. The core use case is where the two meet.
 */
export interface RollupFigureRow {
  readonly eventCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostMicros: number;
}

/**
 * THE BIGINT SEAM (CDR-073 §1-G14) — the only path by which a `bigint` column or a `sum()` becomes a JS number.
 *
 * PostgreSQL returns `bigint` (and `sum(integer)`) as int8, and this repo installs NO `int8` type parser, so
 * node-postgres hands it over as a STRING. Unconverted, `"100" + "200"` is `"100200"`: a total that is nonsense
 * but still serialises as a number, and a drift check that "passes".
 *
 * A global `setTypeParser` was the alternative and is rejected in CDR-073 §1-G14 — it would silently change the
 * meaning of every future bigint column repo-wide to solve a local problem.
 *
 * Throws rather than rounds beyond ±`Number.MAX_SAFE_INTEGER`: past 2^53 a JS number loses low-order digits, and
 * a figure that is wrong in its last digits is indistinguishable from a right one. `null` is 0 because that is
 * what `sum()` returns over zero rows; `undefined` throws, because that means the column was never selected.
 */
export function toRollupFigure(value: string | number | bigint | null | undefined): number {
  if (value === null) return 0;
  if (value === undefined) {
    throw new TypeError('toRollupFigure received undefined — the column was not selected');
  }
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError('usage rollup figure exceeds the safe integer range');
    }
    return Number(value);
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (typeof value === 'string' && value.trim() === '') {
    throw new TypeError('toRollupFigure received an empty string');
  }
  if (!Number.isFinite(n)) {
    throw new TypeError('toRollupFigure received a non-numeric value');
  }
  if (!Number.isInteger(n)) {
    throw new TypeError('usage rollup figures are integer counts and integer micro-units, not fractions');
  }
  if (!Number.isSafeInteger(n)) {
    throw new RangeError('usage rollup figure exceeds the safe integer range');
  }
  return n;
}

/** Shape of the four aggregate columns every sum query below selects, before marshalling. */
interface RawFigureRow {
  readonly event_count: string | number | null;
  readonly input_tokens: string | number | null;
  readonly output_tokens: string | number | null;
  readonly estimated_cost_micros: string | number | null;
}

function toFigures(row: RawFigureRow | undefined): RollupFigureRow {
  if (row === undefined) {
    return { eventCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 };
  }
  return {
    eventCount: toRollupFigure(row.event_count),
    inputTokens: toRollupFigure(row.input_tokens),
    outputTokens: toRollupFigure(row.output_tokens),
    estimatedCostMicros: toRollupFigure(row.estimated_cost_micros),
  };
}

/**
 * Marshal a stored rollup row's four `bigint` figure columns into JS numbers (CDR-073 §1-G14).
 *
 * Exported so a caller that already holds the row (to read `computed_at`, say) converts it here rather than
 * re-querying or — far worse — doing arithmetic on the raw strings the driver returned.
 */
export function rollupRowFigures(row: AccountUsageRollupRow): RollupFigureRow {
  return {
    eventCount: toRollupFigure(row.event_count),
    inputTokens: toRollupFigure(row.input_tokens),
    outputTokens: toRollupFigure(row.output_tokens),
    estimatedCostMicros: toRollupFigure(row.estimated_cost_micros),
  };
}

export class AccountUsageRollupRepository {
  readonly #db: UsageRollupExecutor;
  constructor(db: UsageRollupExecutor) {
    this.#db = db;
  }

  /**
   * Serialize reconciliations of one `(account, period)` against each other, for this transaction.
   *
   * A TRANSACTION-SCOPED ADVISORY LOCK, not a row lock, because the row it protects MAY NOT EXIST YET — a missing
   * projection is the case reconciliation most needs to handle, and `SELECT … FOR UPDATE` locks nothing when it
   * matches nothing, so two concurrent reconciliations of a never-computed period would both proceed.
   *
   * It is released by COMMIT or ROLLBACK; there is no unlock path to forget. The two-key `int4` overload is used
   * with `hashtext` of each component, so the account and the period are distinct lock dimensions. A hash
   * collision between two different periods costs a little serialization and is never a correctness problem.
   *
   * This does NOT make the enclosing READ COMMITTED transaction a snapshot — the per-company sums are still read
   * statement by statement. It closes exactly one hole: two reconciliations racing to write the same period.
   */
  async lockAccountPeriodForReconcile(accountId: string, periodStart: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtext(${accountId}), hashtext(${periodStart}))`.execute(this.#db);
  }

  /** The stored projection for one period, or undefined when it has never been computed. */
  find(accountId: string, periodStart: string): Promise<AccountUsageRollupRow | undefined> {
    return this.#db
      .selectFrom('account_usage_rollups')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('period_start', '=', periodStart)
      .executeTakeFirst();
  }

  /**
   * The stored projection's FIGURES, marshalled through the bigint seam, or `undefined` when no row exists.
   *
   * THE DISTINCTION IS LOAD-BEARING AND `find` CANNOT MAKE IT SAFELY. `find` hands back the raw row, whose four
   * figure columns are `bigint` and therefore STRINGS (§1-G14). A drift check written as `computed - stored.
   * event_count` would then subtract a string: JavaScript coerces it, so the arithmetic silently *works* for
   * subtraction and silently *fails* for anything else — `computed + stored` concatenates, and an equality check
   * against a number is always false. A comparison that is right by coercion is the §0 failure exactly: correct
   * today, wrong the moment someone writes the obvious next line.
   *
   * `undefined` here means NEVER COMPUTED, which is a different fact from "computed and zero" — a caller that
   * collapses them reports "no drift" for an account whose projection does not exist.
   */
  async findFigures(accountId: string, periodStart: string): Promise<RollupFigureRow | undefined> {
    const row = await this.find(accountId, periodStart);
    return row === undefined ? undefined : rollupRowFigures(row);
  }

  /**
   * Write the period's figures, REPLACING whatever was there (CDR-073 §1-G12).
   *
   * Replace, never accumulate: a rebuild is a recomputation of the whole period, so rebuilding twice must produce
   * the same row. An additive upsert would double the totals on the second run, which is the rollup half of
   * trust-critical #12.
   *
   * The conflict target is the `(account_id, period_start)` unique index from 0051.
   */
  async upsert(accountId: string, periodStart: string, figures: RollupFigureRow): Promise<AccountUsageRollupRow> {
    return this.#db
      .insertInto('account_usage_rollups')
      .values({
        account_id: accountId,
        period_start: periodStart,
        event_count: figures.eventCount,
        input_tokens: figures.inputTokens,
        output_tokens: figures.outputTokens,
        estimated_cost_micros: figures.estimatedCostMicros,
      })
      .onConflict((oc) =>
        oc.columns(['account_id', 'period_start']).doUpdateSet({
          event_count: figures.eventCount,
          input_tokens: figures.inputTokens,
          output_tokens: figures.outputTokens,
          estimated_cost_micros: figures.estimatedCostMicros,
          computed_at: sql`now()`,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Sum the CURRENT COMPANY's usage events falling in `periodStart`'s UTC month.
   *
   * The bucket expression is `date_trunc('month', created_at at time zone 'UTC')`, which must agree exactly with
   * `usagePeriodStart` in @acbp/contracts (CDR-073 §1-G8).
   *
   * ENFORCED BY: `usage-rollups.integration.test.ts` → "THE PRODUCTION AGGREGATION PINS UTC", which calls THIS
   * method under a `Pacific/Kiritimati` (UTC+14) session zone. Removing `at time zone 'UTC'` fails it. The
   * earlier version of that test asserted agreement between two expressions it wrote ITSELF and never called
   * this method, so the pin could be deleted with every suite still green — named here because "an integration
   * test covers it" was exactly the claim that turned out to be empty.
   *
   * Confined to one company by the dual-keyed `usage_events` policy, so the caller must already have elevated.
   */
  async sumCompanyUsage(periodStart: string): Promise<RollupFigureRow> {
    const result = await sql<RawFigureRow>`
      select
        count(*) as event_count,
        coalesce(sum(input_tokens), 0) as input_tokens,
        coalesce(sum(output_tokens), 0) as output_tokens,
        coalesce(sum(estimated_cost_micros), 0) as estimated_cost_micros
      from public.usage_events
      where date_trunc('month', created_at at time zone 'UTC') = ${periodStart}::date
    `.execute(this.#db);
    return toFigures(result.rows[0]);
  }

  /**
   * Sum the CURRENT COMPANY's corrections for `periodStart`, bucketed by the CORRECTED EVENT's month.
   *
   * THE JOIN IS THE POINT (CDR-073 §1-G10c). A July event corrected in August belongs to JULY: bucketing by the
   * correction's own `created_at` would leave July permanently wrong while August absorbed an adjustment that has
   * nothing to do with it — and a rebuild would faithfully reproduce the misattribution, so it would never be
   * caught. The period is deliberately not denormalised onto the correction row; it is derivable, and a stored
   * copy is one more thing that can disagree with the ledger.
   *
   * Returns NEGATIVE or zero figures: a correction only ever reduces (§1-G10a).
   */
  async sumCompanyCorrections(periodStart: string): Promise<RollupFigureRow> {
    const result = await sql<RawFigureRow>`
      select
        coalesce(sum(c.event_count_delta), 0) as event_count,
        coalesce(sum(c.input_tokens_delta), 0) as input_tokens,
        coalesce(sum(c.output_tokens_delta), 0) as output_tokens,
        coalesce(sum(c.estimated_cost_micros_delta), 0) as estimated_cost_micros
      from public.usage_corrections c
      join public.usage_events e on e.id = c.corrects_usage_event_id
      where date_trunc('month', e.created_at at time zone 'UTC') = ${periodStart}::date
    `.execute(this.#db);
    return toFigures(result.rows[0]);
  }
}

/** The fields a caller supplies to append a compensating usage entry. Deltas are `<= 0` (CDR-073 §1-G10a). */
export interface NewUsageCorrectionInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly correctsUsageEventId: string;
  readonly eventCountDelta: number;
  readonly inputTokensDelta: number;
  readonly outputTokensDelta: number;
  readonly estimatedCostMicrosDelta: number;
  readonly reason: string;
  readonly createdByUserId: string | null;
}

export class UsageCorrectionRepository {
  readonly #db: UsageRollupExecutor;
  constructor(db: UsageRollupExecutor) {
    this.#db = db;
  }

  /**
   * Append one compensating entry. There is deliberately NO update or delete method — the ledger is append-only
   * (trust-critical #13), and 0051 grants no UPDATE or DELETE to back one anyway.
   *
   * The sign bound, the per-lane magnitude bound against the corrected event, and one-correction-per-event are
   * all enforced by the table (CHECK, trigger, unique index), not here.
   */
  insert(input: NewUsageCorrectionInput): Promise<UsageCorrectionRow> {
    return this.#db
      .insertInto('usage_corrections')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        corrects_usage_event_id: input.correctsUsageEventId,
        event_count_delta: input.eventCountDelta,
        input_tokens_delta: input.inputTokensDelta,
        output_tokens_delta: input.outputTokensDelta,
        estimated_cost_micros_delta: input.estimatedCostMicrosDelta,
        reason: input.reason,
        created_by_user_id: input.createdByUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
