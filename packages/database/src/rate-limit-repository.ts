// @acbp/database — the API request-limit bucket (ACBP-P7-013; CDR-082 §3.2; migration 0055; NFR-010).
//
// ── THE ONE THING THIS FILE IS ABOUT: THE DECISION HAPPENS UNDER THE ROW LOCK ─────────────────────────────────
//
// The obvious implementation is SELECT the bucket, decide in TypeScript, UPDATE it. That is a lost-update race:
// two concurrent requests read the same balance, both decide there is a token, and both spend it. Under exactly
// the burst of traffic a rate limiter exists to bound, the limiter admits roughly twice what it should — and it
// does so silently, because every individual request looks correct in isolation.
//
// So the refill, the comparison and the decrement are all expressions inside ONE `INSERT … ON CONFLICT DO UPDATE`.
// PostgreSQL re-reads the conflicting row UNDER LOCK before evaluating the `SET` and `WHERE` expressions, so a
// second transaction evaluating the same statement sees the first one's decrement. Concurrency is handled by the
// database's row lock rather than by an assumption about how many instances are running.
//
// ── HOW THE VERDICT COMES BACK, WHICH IS SUBTLER THAN IT LOOKS ────────────────────────────────────────────────
//
// `RETURNING` on an `ON CONFLICT DO UPDATE` can see the NEW row and `excluded`, but not the OLD one — so the
// verdict cannot simply be read off the row. It is carried by the `WHERE` clause instead: the update is SKIPPED
// when the bucket is short, which returns ZERO rows, and admitted otherwise, which returns one. `allowed` is
// therefore "did the write happen", which is the same question as "was there a token", asked once.
//
// A refusal must not spend, so the skipped update leaves the balance untouched — a throttled client that still
// paid a token could hold its own bucket at zero forever by retrying.
//
// ── THIS FILE MUST AGREE WITH `consumeTokens`, AND A TEST MEASURES THAT ───────────────────────────────────────
//
// `@acbp/contracts`' `consumeTokens` is the specification (CDR-082 §3.2) and this is a second implementation of
// the same arithmetic in SQL. Two implementations of one rule drift. `rate-limit-bucket.integration.test.ts`
// replays the specification's own cases through this repository against real PostgreSQL and asserts the two
// agree case for case, so a divergence is a red test rather than a discrepancy someone notices later.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import type { DatabaseSchema } from './schema.js';

export type RateLimitExecutor = Kysely<DatabaseSchema>;

/** The two keys CDR-008 §8 rules. A third would be a value decision, not a code change. */
export type RateLimitScopeKind = 'session' | 'account';

export interface ConsumeBucketParams {
  readonly scopeKind: RateLimitScopeKind;
  /** The RAW key (a Clerk session id or an internal account id). Hashed here; never stored or logged raw. */
  readonly scopeKey: string;
  readonly capacityMilli: number;
  readonly refillMilliPerSecond: number;
  readonly costMilli: number;
  /** The caller's clock. Passed in rather than read from `now()` so the suite is deterministic. */
  readonly at: Date;
}

export interface ConsumeBucketResult {
  readonly allowed: boolean;
  /** The balance after the decision. On a refusal this is the refilled balance, unspent. */
  readonly remainingMilli: number;
}

/**
 * `sha256(kind + ':' + key)` in lowercase hex.
 *
 * The kind is inside the digest, not merely a separate column, so a session id and an account id that happened
 * to be equal as strings could never collide onto one bucket. The column exists for diagnostics only.
 */
export function bucketKeyHash(scopeKind: RateLimitScopeKind, scopeKey: string): string {
  return createHash('sha256').update(`${scopeKind}:${scopeKey}`, 'utf8').digest('hex');
}

/**
 * `bigint` arrives from `pg` as a STRING. Parsing rather than trusting the driver is not defensive noise: a
 * silent `'119000' - 1000` is arithmetic, but `'119000' + 1000` is `'1190001000'`, and a limiter whose balance
 * concatenates is a limiter that never refuses again.
 */
function toMilli(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Consume one request's worth of tokens, atomically.
 *
 * Runs on whatever executor it is given and needs NO tenant scope: the table is global and un-RLSed by design
 * (migration 0055), because a session bucket is consulted before any account is known.
 */
export async function consumeBucket(db: RateLimitExecutor, params: ConsumeBucketParams): Promise<ConsumeBucketResult> {
  const { scopeKind, scopeKey, capacityMilli, refillMilliPerSecond, costMilli, at } = params;
  const hash = bucketKeyHash(scopeKind, scopeKey);
  const capacity = sql<string>`${capacityMilli}::bigint`;
  const cost = sql<string>`${costMilli}::bigint`;
  const now = sql<Date>`${at}::timestamptz`;

  // The refilled balance of the EXISTING row, clamped both ways, as one expression over the locked row `b`.
  //
  //   - `greatest(0, least(capacity, b.tokens_milli))` — a corrupt row reads as empty or as full, never as
  //     credit and never as more than the ceiling.
  //   - `greatest(0, extract(epoch from (now - b.updated_at)))` — a BACKWARDS clock accrues nothing rather than
  //     draining a bucket. An NTP correction must not throttle anyone.
  //   - `floor(...)` — integer milli-tokens, mirroring the specification's own flooring so the two agree exactly.
  //   - the outer `least(capacity, ...)` — idle time never banks more than the burst.
  const refilled = sql<string>`least(
    ${capacity},
    greatest(0::bigint, least(${capacity}, b.tokens_milli))
      + floor(greatest(0, extract(epoch from (${now} - b.updated_at))) * ${refillMilliPerSecond})::bigint
  )`;

  // A first sighting starts FULL, then pays for this request. A key seen for the first time has by definition
  // not spent anything, and starting empty would refuse every user's first request.
  const initial = sql<string>`${capacityMilli - costMilli}::bigint`;

  const result = await sql<{ allowed: boolean; tokens_milli: string | number }>`
    with consumed as (
      insert into public.api_rate_limit_buckets as b (scope_key_hash, scope_kind, tokens_milli, updated_at)
      values (${hash}, ${scopeKind}, ${initial}, ${now})
      on conflict (scope_key_hash) do update
        set tokens_milli = ${refilled} - ${cost},
            updated_at = ${now}
        where ${refilled} >= ${cost}
      returning tokens_milli
    )
    select
      exists (select 1 from consumed) as allowed,
      coalesce(
        (select tokens_milli from consumed),
        -- The refusal path: report the REFILLED balance the decision was made against, not the stale stored
        -- one, so the caller's retry advice is computed from the same number the database compared.
        (select least(
                  ${capacity},
                  greatest(0::bigint, least(${capacity}, b.tokens_milli))
                    + floor(greatest(0, extract(epoch from (${now} - b.updated_at))) * ${refillMilliPerSecond})::bigint
                )
         from public.api_rate_limit_buckets b
         where b.scope_key_hash = ${hash}),
        0::bigint
      ) as tokens_milli
  `.execute(db);

  const row = result.rows[0];
  if (row === undefined) {
    // Unreachable: the outer SELECT has no FROM and always produces exactly one row. Treated as a REFUSAL
    // rather than an admission, because a limiter whose unreachable branch fails open is a limiter that fails
    // open in production and nowhere else.
    return { allowed: false, remainingMilli: 0 };
  }
  return { allowed: row.allowed === true, remainingMilli: toMilli(row.tokens_milli) };
}
