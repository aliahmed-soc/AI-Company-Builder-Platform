// ACBP-P7-013 / CDR-081 — real-PostgreSQL proof of `api_rate_limit_buckets` under the RESTRICTED role.
//
// ── WHY THIS SUITE IS A DIFFERENTIAL TEST AND NOT A LIST OF EXPECTATIONS ──────────────────────────────────────
//
// The bucket arithmetic exists TWICE: once as `consumeTokens` in `@acbp/contracts` (the specification) and once
// as SQL inside `consumeBucket` (the implementation, in SQL because the decision has to happen under the row
// lock — CDR-081 §3.2). Two implementations of one rule drift, and hand-written expectations here would drift
// with whichever one the author was looking at.
//
// So §1 replays the SPECIFICATION'S OWN CASES through the database and asserts the two agree, case for case. The
// expected values are computed by `consumeTokens`, never typed in. Adding a case to `rate-limit.test.ts`
// therefore extends this suite too, and a divergence between TypeScript and SQL is a red test rather than a
// discrepancy discovered in production.
//
// §2 covers what the specification cannot: concurrency (the lost-update race that motivates the whole design),
// the grants, and the CHECK constraints.
//
// Setup/seed on the superuser (owner); every assertion runs as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner).
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { consumeTokens, rateLimitRule, MILLI, type BucketState } from '@acbp/contracts';
import { createDatabase, closeDatabase, migrateToLatest, consumeBucket, bucketKeyHash, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `ratelimit_${'test'}_pw_1970`;

const CHECK_VIOLATION = '23514';
const INSUFFICIENT_PRIVILEGE = '42501';

const ALL = ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'usage_corrections', 'api_rate_limit_buckets', 'account_usage_rollups', 'usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

/** The SQLSTATE of a rejected operation — errors are sanitized, so the code is the only stable anchor. */
const isSqlState = (v: unknown): v is string => typeof v === 'string' && /^[0-9A-Z]{5}$/.test(v);
const sqlStateOf = (p: Promise<unknown>): Promise<string> =>
  p.then(() => 'no-error').catch((e: unknown) => {
    for (let cur: unknown = e, hops = 0; cur !== null && cur !== undefined && hops < 5; hops += 1) {
      const node = cur as { code?: unknown; cause?: unknown };
      if (isSqlState(node.code)) return node.code;
      cur = node.cause;
    }
    return /sqlstate=([0-9A-Z]{5})/.exec(String(e))?.[1] ?? 'unknown';
  });

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-ratelimit-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-ratelimit-test' }));
}

/** CDR-008 §8's per-session rule — the shape every §1 case uses. */
const SESSION = rateLimitRule({ perMinute: 60, burst: 120 });
const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (msAfterT0: number) => new Date(T0.getTime() + msAfterT0);

describe.skipIf(!hasTestDatabase)('api_rate_limit_buckets (real PostgreSQL, restricted role) — ACBP-P7-013/CDR-081', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;

  beforeAll(async () => {
    su = superuserClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(su);
    expect(r.error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();
  }, 120_000);

  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (su) {
      try {
        await sql`alter role acbp_app nologin`.execute(su.kysely);
      } catch {
        /* best effort */
      }
      for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
        await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
      }
      await closeDatabase(su);
    }
  });

  beforeEach(async () => {
    await sql`truncate table public.api_rate_limit_buckets`.execute(su.kysely);
  });

  /** Seed a bucket at an exact balance and timestamp — the only way to place a bucket in a chosen past state. */
  const seed = async (key: string, milli: number, atMs: number): Promise<void> => {
    await sql`
      insert into public.api_rate_limit_buckets (scope_key_hash, scope_kind, tokens_milli, updated_at)
      values (${bucketKeyHash('session', key)}, 'session', ${milli}::bigint, ${at(atMs)}::timestamptz)
    `.execute(su.kysely);
  };

  const consume = (key: string, atMs: number) =>
    consumeBucket(app.kysely, {
      scopeKind: 'session',
      scopeKey: key,
      capacityMilli: SESSION.capacityMilli,
      refillMilliPerSecond: SESSION.refillMilliPerSecond,
      costMilli: MILLI,
      at: at(atMs),
    });

  // ── §1 The differential: SQL must agree with the specification, case for case ────────────────────────────
  describe('§1 agrees with `consumeTokens`, the specification', () => {
    // Every case: a stored state (or none), and the instant the request arrives. The expectation is COMPUTED by
    // the specification — never typed in — so this table cannot encode a belief about the SQL that is wrong.
    const CASES: ReadonlyArray<{ name: string; stored: BucketState | null; atMs: number }> = [
      { name: 'a fresh key starts full', stored: null, atMs: 0 },
      { name: 'an empty bucket refuses', stored: { milli: 0, atMs: 0 }, atMs: 0 },
      { name: 'a partial token refuses and is preserved', stored: { milli: MILLI / 2, atMs: 0 }, atMs: 0 },
      { name: 'exactly one token admits and empties', stored: { milli: MILLI, atMs: 0 }, atMs: 0 },
      { name: 'refills at the sustained rate over ten seconds', stored: { milli: 0, atMs: 0 }, atMs: 10_000 },
      { name: 'refills proportionally within a second', stored: { milli: 0, atMs: 0 }, atMs: 250 },
      { name: 'never refills above the burst after a day idle', stored: { milli: 0, atMs: 0 }, atMs: 86_400_000 },
      { name: 'a backwards clock accrues nothing rather than draining', stored: { milli: 10 * MILLI, atMs: 5_000 }, atMs: 1_000 },
      { name: 'a full bucket stays capped', stored: { milli: 120 * MILLI, atMs: 0 }, atMs: 60_000 },
      { name: 'one milli-token short still refuses', stored: { milli: MILLI - 1, atMs: 0 }, atMs: 0 },
    ];

    for (const [i, c] of CASES.entries()) {
      test(`${c.name}`, async () => {
        const key = `spec-case-${i}`;
        if (c.stored !== null) await seed(key, c.stored.milli, c.stored.atMs);

        const expected = consumeTokens(SESSION, c.stored, c.atMs);
        const actual = await consume(key, c.atMs);

        expect(actual.allowed).toBe(expected.allowed);
        expect(actual.remainingMilli).toBe(expected.remainingMilli);
      });
    }

    test('a whole burst-then-sustain sequence tracks the specification step for step', async () => {
      // The property CDR-008 §8 actually states, replayed through the database: 120 admitted from the burst,
      // then 60/min. A per-step comparison, so a divergence names the step it began at.
      const key = 'sequence';
      let state: BucketState | null = null;
      for (let i = 0; i < 130; i += 1) {
        const ms = i * 100; // 10 req/s — far above the 1/s refill, so the burst drains
        const expected = consumeTokens(SESSION, state, ms);
        const actual = await consume(key, ms);
        expect({ step: i, ...actual }).toEqual({ step: i, allowed: expected.allowed, remainingMilli: expected.remainingMilli });
        state = { milli: expected.remainingMilli, atMs: ms };
      }
    }, 60_000);
  });

  // ── §2 What the specification cannot cover ───────────────────────────────────────────────────────────────
  describe('§2 concurrency, grants and constraints', () => {
    test('CONCURRENT consumers cannot both spend the last token (the lost-update race)', async () => {
      // THE ASSERTION THIS WHOLE DESIGN EXISTS FOR. A read-decide-write implementation passes every test in §1
      // and fails this one: both callers read one token, both decide yes, both write zero.
      const key = 'race-last-token';
      await seed(key, MILLI, 0); // exactly one token, and no refill within the same instant
      const results = await Promise.all([consume(key, 0), consume(key, 0), consume(key, 0), consume(key, 0)]);
      expect(results.filter((r) => r.allowed).length).toBe(1);
      expect(results.filter((r) => !r.allowed).length).toBe(3);
    });

    test('CONCURRENT consumers against a full bucket admit exactly the capacity, never more', async () => {
      const key = 'race-full-burst';
      // 150 simultaneous requests at one instant against a 120 burst: 120 admitted, 30 refused, no refill.
      const attempts = Array.from({ length: 150 }, () => consume(key, 0));
      const results = await Promise.all(attempts);
      expect(results.filter((r) => r.allowed).length).toBe(120);
    }, 60_000);

    test('the app role cannot DELETE or TRUNCATE a bucket — a limiter that can reset itself is not a limit', async () => {
      await seed('no-delete', 0, 0);
      expect(await sqlStateOf(sql`delete from public.api_rate_limit_buckets`.execute(app.kysely))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlStateOf(sql`truncate table public.api_rate_limit_buckets`.execute(app.kysely))).toBe(INSUFFICIENT_PRIVILEGE);
    });

    test('a negative balance is refused by the database, not merely by the arithmetic', async () => {
      expect(
        await sqlStateOf(
          sql`insert into public.api_rate_limit_buckets (scope_key_hash, scope_kind, tokens_milli, updated_at)
              values (${bucketKeyHash('session', 'neg')}, 'session', -1::bigint, now())`.execute(su.kysely),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    test('an unknown scope kind is refused — the vocabulary is closed', async () => {
      expect(
        await sqlStateOf(
          sql`insert into public.api_rate_limit_buckets (scope_key_hash, scope_kind, tokens_milli, updated_at)
              values (${bucketKeyHash('session', 'kind')}, 'ip', 0::bigint, now())`.execute(su.kysely),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    test('a RAW key is refused by the shape CHECK — the column cannot hold an unhashed session id', async () => {
      // The guard that makes "we never store raw identifiers" a property of the schema rather than a habit of
      // the one function that currently writes here.
      expect(
        await sqlStateOf(
          sql`insert into public.api_rate_limit_buckets (scope_key_hash, scope_kind, tokens_milli, updated_at)
              values ('sess_2abcDEF', 'session', 0::bigint, now())`.execute(su.kysely),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    test('the stored key is the DIGEST — no raw session id reaches the table', async () => {
      await consume('sess_secret_value', 0);
      const rows = await sql<{ scope_key_hash: string }>`select scope_key_hash from public.api_rate_limit_buckets`.execute(su.kysely);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.scope_key_hash).toBe(bucketKeyHash('session', 'sess_secret_value'));
      expect(rows.rows[0]!.scope_key_hash).not.toContain('sess_secret_value');
    });

    test('session and account keys with the SAME string do not share a bucket', async () => {
      // The kind is inside the digest for exactly this reason.
      const shared = 'collide';
      const rule = { capacityMilli: SESSION.capacityMilli, refillMilliPerSecond: SESSION.refillMilliPerSecond, costMilli: MILLI, at: at(0) };
      await consumeBucket(app.kysely, { scopeKind: 'session', scopeKey: shared, ...rule });
      await consumeBucket(app.kysely, { scopeKind: 'account', scopeKey: shared, ...rule });
      const rows = await sql<{ n: string }>`select count(*)::text as n from public.api_rate_limit_buckets`.execute(su.kysely);
      expect(rows.rows[0]!.n).toBe('2');
    });
  });
});
