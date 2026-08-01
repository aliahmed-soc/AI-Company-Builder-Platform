// ACBP-P6-009 / CDR-073 — real-PostgreSQL proof of `account_usage_rollups` + `usage_corrections` under the
// RESTRICTED role.
//
// CDR-073 §0: this ticket's failure mode is "the number is wrong and nothing notices". A constraint written in a
// migration and a constraint that REJECTS THE ROW are different claims, and only the second one is worth having
// here — a rollup that silently accepts a nonsense figure looks exactly like one that is right.
//
// Two assertions in this file carry more weight than the rest and are worth naming up front:
//   - the SQL and TypeScript period derivations agree on the SAME rows (§1-G8). If they ever disagree, every
//     total is quietly split across two periods and no other test in the repo would notice.
//   - a correction lands in the CORRECTED EVENT's period, not its own (§1-G10c). Getting this wrong leaves a past
//     period permanently wrong in a way a rebuild faithfully reproduces.
//
// Setup/seed on the superuser (owner); every assertion runs as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner).
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { usagePeriodStart } from '@acbp/contracts';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, toRollupFigure, AccountUsageRollupRepository, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `rollup_${'test'}_pw_1970`;

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const INSUFFICIENT_PRIVILEGE = '42501';
const FK_VIOLATION = '23503';

const ALL = ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'usage_corrections', 'account_usage_rollups', 'usage_events', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

/**
 * The SQLSTATE of a rejected operation, or 'no-error' if it unexpectedly succeeded.
 *
 * The SQLSTATE rather than a constraint name, because `toDatabaseError` sanitizes every database error down to a
 * category and a code — no constraint name reaches a caller, and that sanitization is a security property this
 * suite must not ask anyone to relax. Pinning the EXACT code is what stops one failure mode masquerading as
 * another; a bare `.rejects.toThrow()` is satisfied by all of them, including a typo in the test's own SQL.
 */
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
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-rollup-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-rollup-test' }));
}

describe.skipIf(!hasTestDatabase)('account_usage_rollups + usage_corrections (real PostgreSQL, restricted role) — ACBP-P6-009/CDR-073', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let userU = '';
  let accountA = '';
  let accountB = '';
  let companyA1 = '';
  let companyA2 = '';
  let companyB1 = '';

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const scope = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });
  /** Account context ONLY — the shape the rollup read takes, with no company current. */
  const acct = (a: string) => ({ 'app.current_account': a });

  /**
   * Seed a usage event as the APP role, so RLS is exercised on the path the product uses.
   *
   * `createdAt` is settable because the period tests need events in specific months; the column has a default and
   * no update grant, so a test writing it at INSERT time is the only way to place one in the past.
   */
  const insertEvent = async (
    a: string,
    c: string,
    row: { inputTokens?: number; outputTokens?: number; costMicros?: number; createdAt?: string },
  ): Promise<string> =>
    asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`
        insert into usage_events (account_id, company_id, provider, model, task_class, outcome, input_tokens, output_tokens, estimated_cost_micros, fallback_used, latency_ms, created_at)
        values (${a}::uuid, ${c}::uuid, 'synthetic', 'model-x@1', 'generation', 'ok',
                ${row.inputTokens ?? 100}, ${row.outputTokens ?? 50}, ${row.costMicros ?? 1000}, false, 42,
                coalesce(${row.createdAt ?? null}::timestamptz, now()))
        returning id
      `.execute(k);
      return r.rows[0]!.id;
    });

  const insertCorrection = (
    a: string,
    c: string,
    row: { eventId: string; events?: number; input?: number; output?: number; cost?: number; reason?: string },
  ): Promise<string> =>
    asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`
        insert into usage_corrections (account_id, company_id, corrects_usage_event_id, event_count_delta, input_tokens_delta, output_tokens_delta, estimated_cost_micros_delta, reason, created_by_user_id)
        values (${a}::uuid, ${c}::uuid, ${row.eventId}::uuid, ${row.events ?? 0}, ${row.input ?? -10}, ${row.output ?? 0}, ${row.cost ?? 0}, ${row.reason ?? 'synthetic correction'}, ${userU}::uuid)
        returning id
      `.execute(k);
      return r.rows[0]!.id;
    });

  const insertRollup = (a: string, period: string, figures?: { events?: number; input?: number; output?: number; cost?: number }): Promise<string> =>
    asApp(acct(a), async (k) => {
      const r = await sql<{ id: string }>`
        insert into account_usage_rollups (account_id, period_start, event_count, input_tokens, output_tokens, estimated_cost_micros)
        values (${a}::uuid, ${period}::date, ${figures?.events ?? 1}, ${figures?.input ?? 10}, ${figures?.output ?? 5}, ${figures?.cost ?? 100})
        returning id
      `.execute(k);
      return r.rows[0]!.id;
    });

  beforeAll(async () => {
    su = superuserClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(su);
    expect(r.error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();

    const u = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_roll', 'user_roll_u', now()) returning id`.execute(su.kysely);
    userU = u.rows[0]!.id;
    const v = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_roll', 'user_roll_v', now()) returning id`.execute(su.kysely);
    const userV = v.rows[0]!.id;
    accountA = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    accountB = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    companyA1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyA2 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyB1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountB}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;

    // Clean down/up BY NAME, so 0051 is proven REVERSIBLE and re-appliable rather than only ever applied once.
    // The down step also has to drop the `usage_events` unique constraint it added; if it did not, the second
    // `up` would fail with 42P07 and this line is what would catch it.
    const down = await createMigrator(su).migrateTo('0050_emergency_stops');
    expect(down.error).toBeUndefined();
    const up = await migrateToLatest(su);
    expect(up.error).toBeUndefined();
  }, 120_000);

  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (su) {
      try {
        await sql`alter role acbp_app nologin`.execute(su.kysely);
      } catch {
        /* best effort */
      }
      for (const t of ALL) await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(su);
    }
  });

  beforeEach(async () => {
    await sql`delete from usage_corrections`.execute(su.kysely);
    await sql`delete from account_usage_rollups`.execute(su.kysely);
    await sql`delete from usage_events`.execute(su.kysely);
  });

  // ── the two derivations that must agree, or every total is quietly wrong ───────────────────────────────────

  test('THE PRODUCTION AGGREGATION PINS UTC — run under a session zone 14 hours away (CDR-073 §1-G8)', async () => {
    // WHAT THE FIRST VERSION OF THIS TEST DID WRONG, recorded because it was this ticket's own §0 failure
    // committed inside the assertion written to prevent it. It issued its OWN copy of
    // `date_trunc('month', created_at at time zone 'UTC')` and compared that to `usagePeriodStart`. Two
    // hand-written expressions agreeing proves nothing about the THIRD copy — the one inside `sumCompanyUsage`,
    // which is the expression that actually decides a customer's bill. Deleting `at time zone 'UTC'` from BOTH
    // repository queries left every assertion in this file green, because CI's server runs UTC and the two
    // spellings are then byte-identical.
    //
    // So this version calls the PRODUCTION methods, under a session TimeZone 14 hours from UTC, where the pin is
    // the only thing that can produce the expected answer. Remove it and this test fails; that is the whole
    // point of it existing.
    //
    // `sumCompanyUsage`/`sumCompanyCorrections` have no other test in the repo, so this is also the only place
    // either method is executed outside the service.
    const zone = sql`set local timezone to 'Pacific/Kiritimati'`; // UTC+14, the largest standard offset there is

    // 23:30 on 31 July UTC is already 13:30 on 1 AUGUST in UTC+14. The event belongs to JULY either way.
    const julyBoundary = '2026-07-31T23:30:00.000Z';
    const eventId = await insertEvent(accountA, companyA1, { createdAt: julyBoundary, inputTokens: 11, outputTokens: 5, costMicros: 70 });
    expect(usagePeriodStart(new Date(julyBoundary)), 'the TypeScript half must bucket by UTC').toBe('2026-07-01');

    const sums = await asApp(scope(accountA, companyA1), async (k) => {
      await zone.execute(k);
      const repo = new AccountUsageRollupRepository(k);
      return { july: await repo.sumCompanyUsage('2026-07-01'), august: await repo.sumCompanyUsage('2026-08-01') };
    });
    expect(sums.july.eventCount, 'a 31-July-UTC event must sum into JULY even under a UTC+14 session').toBe(1);
    expect(sums.july.inputTokens).toBe(11);
    expect(sums.july.estimatedCostMicros).toBe(70);
    expect(sums.august.eventCount, '...and must NOT appear in August').toBe(0);

    // The corrections aggregation carries its own copy of the expression and buckets by the CORRECTED EVENT's
    // month (§1-G10c), so it needs the same proof rather than inheriting this one.
    await insertCorrection(accountA, companyA1, { eventId, input: -4 });
    const corrections = await asApp(scope(accountA, companyA1), async (k) => {
      await zone.execute(k);
      const repo = new AccountUsageRollupRepository(k);
      return { july: await repo.sumCompanyCorrections('2026-07-01'), august: await repo.sumCompanyCorrections('2026-08-01') };
    });
    expect(corrections.july.inputTokens, 'the correction follows its event into JULY').toBe(-4);
    expect(corrections.august.inputTokens).toBe(0);
  });

  test('A CORRECTION BELONGS TO THE CORRECTED EVENT\'S PERIOD, not its own (CDR-073 §1-G10c)', async () => {
    // A July event corrected in August must reduce JULY. Bucketing by the correction's own created_at would leave
    // July permanently wrong while August absorbed an adjustment unrelated to it — and because a rebuild would
    // reproduce the same misattribution, nothing downstream would ever flag it.
    const julyEvent = await insertEvent(accountA, companyA1, { createdAt: '2026-07-10T09:00:00.000Z', inputTokens: 500, costMicros: 5000 });
    await insertCorrection(accountA, companyA1, { eventId: julyEvent, input: -200, cost: -2000 });

    const bucketed = await asApp(scope(accountA, companyA1), async (k) =>
      sql<{ period: string; input: string; cost: string }>`
        select to_char(date_trunc('month', e.created_at at time zone 'UTC'), 'YYYY-MM-DD') as period,
               sum(c.input_tokens_delta)::text as input,
               sum(c.estimated_cost_micros_delta)::text as cost
        from usage_corrections c join usage_events e on e.id = c.corrects_usage_event_id
        group by 1
      `.execute(k),
    );
    expect(bucketed.rows).toHaveLength(1);
    expect(bucketed.rows[0]!.period).toBe('2026-07-01');
    expect(toRollupFigure(bucketed.rows[0]!.input)).toBe(-200);
    expect(toRollupFigure(bucketed.rows[0]!.cost)).toBe(-2000);
  });

  // ── the accumulator is wider than the thing it accumulates (CDR-073 §1-G13/G14) ────────────────────────────

  test('a period total EXCEEDING int4 is summed and stored correctly — the overflow §1-G13 exists for', async () => {
    // Two events at 2e9 micro-units each: the sum is 4e9, past int4's 2.147e9 ceiling. With integer rollup
    // columns this is `22003 numeric_value_out_of_range` at best and a wrong number at worst.
    await insertEvent(accountA, companyA1, { costMicros: 2_000_000_000, inputTokens: 2_000_000_000 });
    await insertEvent(accountA, companyA1, { costMicros: 2_000_000_000, inputTokens: 2_000_000_000 });

    const summed = await asApp(scope(accountA, companyA1), async (k) =>
      sql<{ cost: string; input: string }>`
        select coalesce(sum(estimated_cost_micros), 0)::text as cost, coalesce(sum(input_tokens), 0)::text as input from usage_events
      `.execute(k),
    );
    const cost = toRollupFigure(summed.rows[0]!.cost);
    const input = toRollupFigure(summed.rows[0]!.input);
    expect(cost).toBe(4_000_000_000);
    expect(input).toBe(4_000_000_000);
    expect(cost).toBeGreaterThan(2_147_483_647);

    // And the rollup column actually HOLDS it — the round trip is the claim, not the sum alone.
    await insertRollup(accountA, '2026-08-01', { cost, input });
    const stored = await asApp(acct(accountA), async (k) =>
      sql<{ estimated_cost_micros: string; input_tokens: string }>`select estimated_cost_micros, input_tokens from account_usage_rollups`.execute(k),
    );
    expect(toRollupFigure(stored.rows[0]!.estimated_cost_micros)).toBe(4_000_000_000);
    expect(toRollupFigure(stored.rows[0]!.input_tokens)).toBe(4_000_000_000);
  });

  test('bigint figures cross the driver as STRINGS — the fact §1-G14 is built on', async () => {
    // Pinning this rather than assuming it: if a future dependency bump installs an int8 parser, this test fails
    // and the reason `toRollupFigure` exists gets re-examined, instead of the helper quietly becoming a no-op
    // whose guards nobody notices are now unreachable.
    await insertRollup(accountA, '2026-08-01', { cost: 7 });
    const raw = await asApp(acct(accountA), async (k) =>
      sql<{ estimated_cost_micros: unknown }>`select estimated_cost_micros from account_usage_rollups`.execute(k),
    );
    expect(typeof raw.rows[0]!.estimated_cost_micros).toBe('string');
  });

  // ── the rollup's own constraints ───────────────────────────────────────────────────────────────────────────

  test('the period key MUST be the first of a month — a mid-month key would split one period in two', async () => {
    expect(await sqlStateOf(insertRollup(accountA, '2026-08-17'))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(insertRollup(accountA, '2026-08-31'))).toBe(CHECK_VIOLATION);
    await expect(insertRollup(accountA, '2026-08-01')).resolves.toEqual(expect.any(String));
  });

  test('every lane is NON-NEGATIVE — a negative token count must never reach a billing surface', async () => {
    expect(await sqlStateOf(insertRollup(accountA, '2026-08-01', { events: -1 }))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(insertRollup(accountA, '2026-08-01', { input: -1 }))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(insertRollup(accountA, '2026-08-01', { output: -1 }))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(insertRollup(accountA, '2026-08-01', { cost: -1 }))).toBe(CHECK_VIOLATION);
  });

  test('ONE ROW PER (account, period) — a second insert conflicts rather than doubling the account total', async () => {
    await insertRollup(accountA, '2026-08-01');
    expect(await sqlStateOf(insertRollup(accountA, '2026-08-01'))).toBe(UNIQUE_VIOLATION);
    // A different period and a different account are both fine — the index is not simply refusing everything.
    await expect(insertRollup(accountA, '2026-09-01')).resolves.toEqual(expect.any(String));
    await expect(insertRollup(accountB, '2026-08-01')).resolves.toEqual(expect.any(String));
  });

  test('the idempotent upsert REPLACES the figures — rebuilding twice does not double them (§1-G12)', async () => {
    const upsert = (cost: number) =>
      asApp(acct(accountA), async (k) =>
        sql`
          insert into account_usage_rollups (account_id, period_start, event_count, input_tokens, output_tokens, estimated_cost_micros)
          values (${accountA}::uuid, '2026-08-01'::date, 3, 30, 15, ${cost})
          on conflict (account_id, period_start) do update set
            event_count = excluded.event_count, input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens, estimated_cost_micros = excluded.estimated_cost_micros,
            computed_at = now()
        `.execute(k),
      );
    await upsert(900);
    await upsert(900);
    const rows = await asApp(acct(accountA), async (k) =>
      sql<{ estimated_cost_micros: string; event_count: string }>`select estimated_cost_micros, event_count from account_usage_rollups`.execute(k),
    );
    expect(rows.rows).toHaveLength(1);
    expect(toRollupFigure(rows.rows[0]!.estimated_cost_micros)).toBe(900); // not 1800
    expect(toRollupFigure(rows.rows[0]!.event_count)).toBe(3); // not 6
  });

  test('the rollup is READABLE UNDER ACCOUNT SCOPE with no company set — the whole reason it is account-keyed', async () => {
    await insertRollup(accountA, '2026-08-01', { cost: 4242 });
    const rows = await asApp(acct(accountA), async (k) => sql<{ estimated_cost_micros: string }>`select estimated_cost_micros from account_usage_rollups`.execute(k));
    expect(rows.rows).toHaveLength(1);
    expect(toRollupFigure(rows.rows[0]!.estimated_cost_micros)).toBe(4242);
  });

  test('...and equally readable while ELEVATED into a company — the rebuild writes it in that state', async () => {
    await insertRollup(accountA, '2026-08-01', { cost: 4242 });
    const rows = await asApp(scope(accountA, companyA1), async (k) => sql<{ estimated_cost_micros: string }>`select estimated_cost_micros from account_usage_rollups`.execute(k));
    expect(rows.rows).toHaveLength(1);
  });

  test('another account CANNOT see or write this account\'s rollup', async () => {
    await insertRollup(accountA, '2026-08-01');
    const seen = await asApp(acct(accountB), async (k) => sql<{ id: string }>`select id from account_usage_rollups`.execute(k));
    expect(seen.rows).toHaveLength(0);
    // Writing a row keyed to ANOTHER account is refused by the WITH CHECK, not silently accepted.
    expect(
      await sqlStateOf(
        asApp(acct(accountB), async (k) =>
          sql`insert into account_usage_rollups (account_id, period_start) values (${accountA}::uuid, '2026-09-01'::date)`.execute(k),
        ),
      ),
    ).not.toBe('no-error');
  });

  test('the app role has NO DELETE on the rollup — a projection row is replaced, never removed', async () => {
    await insertRollup(accountA, '2026-08-01');
    expect(await sqlStateOf(asApp(acct(accountA), async (k) => sql`delete from account_usage_rollups`.execute(k)))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  test('the app role CANNOT re-key a rollup into another account or period — the column grant excludes both', async () => {
    // The load-bearing half of the column-scoped UPDATE grant. With a table-wide grant this UPDATE would succeed
    // and neither RI nor the account-keyed policy would object, because the new key is still the caller's account.
    await insertRollup(accountA, '2026-08-01');
    expect(
      await sqlStateOf(asApp(acct(accountA), async (k) => sql`update account_usage_rollups set period_start = '2026-09-01'::date`.execute(k))),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await sqlStateOf(asApp(acct(accountA), async (k) => sql`update account_usage_rollups set account_id = ${accountB}::uuid`.execute(k))),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    // ...while the figures ARE updatable, so the grant is not simply refusing everything.
    await expect(asApp(acct(accountA), async (k) => sql`update account_usage_rollups set event_count = 9`.execute(k))).resolves.toBeDefined();
  });

  // ── corrections: append-only, bounded, one per event ───────────────────────────────────────────────────────

  test('a correction may only ever REDUCE — a positive delta is unstorable (§1-G10a)', async () => {
    const e = await insertEvent(accountA, companyA1, { inputTokens: 100, outputTokens: 50, costMicros: 1000 });
    expect(await sqlStateOf(insertCorrection(accountA, companyA1, { eventId: e, input: 5 }))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(insertCorrection(accountA, companyA1, { eventId: e, events: 1, input: 0 }))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(insertCorrection(accountA, companyA1, { eventId: e, input: 0, cost: 5 }))).toBe(CHECK_VIOLATION);
    // Inflating recorded usage must require writing a real metered event, never a correction.
    await expect(insertCorrection(accountA, companyA1, { eventId: e, input: -5 })).resolves.toEqual(expect.any(String));
  });

  test('an all-zero correction is unstorable — an audited act that changed nothing is worse than no record', async () => {
    const e = await insertEvent(accountA, companyA1, {});
    expect(await sqlStateOf(insertCorrection(accountA, companyA1, { eventId: e, events: 0, input: 0, output: 0, cost: 0 }))).toBe(CHECK_VIOLATION);
  });

  test('a correction CANNOT subtract more than the event recorded, per lane (§1-G10, the trigger)', async () => {
    const e = await insertEvent(accountA, companyA1, { inputTokens: 100, outputTokens: 50, costMicros: 1000 });
    // The `credit_transactions` release-exceeds-reservation hole, in its usage shape: without the trigger, an
    // event of 100 tokens could be corrected by -2,000,000,000 and pass every CHECK in the table.
    expect(await sqlStateOf(insertCorrection(accountA, companyA1, { eventId: e, input: -101 }))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(insertCorrection(accountA, companyA1, { eventId: e, input: 0, output: -51 }))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(insertCorrection(accountA, companyA1, { eventId: e, input: 0, cost: -1001 }))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(insertCorrection(accountA, companyA1, { eventId: e, events: -2, input: 0, output: 0, cost: -1 }))).toBe(CHECK_VIOLATION);
    // Exactly retracting the event is legal — the bound is inclusive, so a full retraction stays expressible.
    await expect(
      insertCorrection(accountA, companyA1, { eventId: e, events: -1, input: -100, output: -50, cost: -1000 }),
    ).resolves.toEqual(expect.any(String));
  });

  test('AT MOST ONE correction per event — stacked corrections cannot walk a lane negative (§1-G10b)', async () => {
    const e = await insertEvent(accountA, companyA1, { inputTokens: 100 });
    await insertCorrection(accountA, companyA1, { eventId: e, input: -100 });
    // Each of these is individually within the bound; together they would subtract 200 from a 100-token event.
    expect(await sqlStateOf(insertCorrection(accountA, companyA1, { eventId: e, input: -100 }))).toBe(UNIQUE_VIOLATION);
  });

  /** Insert a correction as the SUPERUSER, bypassing RLS — used to prove a constraint the trigger otherwise hides. */
  const insertCorrectionAsOwner = (a: string, c: string, eventId: string): Promise<unknown> =>
    sql`
      insert into usage_corrections (account_id, company_id, corrects_usage_event_id, input_tokens_delta, reason, created_by_user_id)
      values (${a}::uuid, ${c}::uuid, ${eventId}::uuid, -10, 'owner-path probe', ${userU}::uuid)
    `.execute(su.kysely);

  test('a correction cannot reference an event in ANOTHER COMPANY — refused by RLS first, and by the FK underneath', async () => {
    const foreign = await insertEvent(accountA, companyA2, { inputTokens: 100 });

    // (1) THE PRODUCT PATH refuses with 23514, NOT the FK's 23503 — and the order is the point. A BEFORE INSERT
    // trigger runs ahead of constraint checking, and scoped into A1 the app role cannot SEE the A2 event, so the
    // trigger's fail-closed branch fires: a bound that cannot be checked because the row is invisible must refuse
    // rather than skip. This is that branch, which nothing else in the suite reaches.
    expect(await sqlStateOf(insertCorrection(accountA, companyA1, { eventId: foreign, input: -10 }))).toBe(CHECK_VIOLATION);

    // (2) THE COMPOSITE FK, PROVEN INDEPENDENTLY. Assertion (1) alone would pass just as happily if the tenant pin
    // did not exist at all — the trigger would still refuse, and the FK's absence would be invisible. As a
    // superuser the trigger's visibility check finds the row and its account check passes (same account), so the
    // only thing left to reject is the FK itself. RI checks always bypass RLS, which is exactly why the pin has to
    // be composite: a single-column FK would accept `account_id = A` beside a FOREIGN `company_id` and corrupt
    // per-company attribution without tripping a policy.
    expect(await sqlStateOf(insertCorrectionAsOwner(accountA, companyA1, foreign))).toBe(FK_VIOLATION);
  });

  test('a correction cannot reference an event in another ACCOUNT', async () => {
    const foreign = await insertEvent(accountB, companyB1, { inputTokens: 100 });
    // Same ordering as above: the app role cannot see account B's event, so the trigger refuses first.
    expect(await sqlStateOf(insertCorrection(accountA, companyA1, { eventId: foreign, input: -10 }))).toBe(CHECK_VIOLATION);
    // As a superuser the row IS visible, so the trigger's EXPLICIT same-account check is what rejects — a distinct
    // branch from the visibility one above, and the reason the trigger checks the account at all rather than
    // leaving it to the FK.
    expect(await sqlStateOf(insertCorrectionAsOwner(accountA, companyA1, foreign))).toBe(CHECK_VIOLATION);
  });

  test('the reason is required and bounded', async () => {
    const e = await insertEvent(accountA, companyA1, {});
    expect(await sqlStateOf(insertCorrection(accountA, companyA1, { eventId: e, input: -1, reason: '' }))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(insertCorrection(accountA, companyA1, { eventId: e, input: -1, reason: 'x'.repeat(501) }))).toBe(CHECK_VIOLATION);
  });

  test('corrections are APPEND-ONLY — no UPDATE and no DELETE at any level (trust-critical #13)', async () => {
    const e = await insertEvent(accountA, companyA1, { inputTokens: 100 });
    await insertCorrection(accountA, companyA1, { eventId: e, input: -10 });
    expect(await sqlStateOf(asApp(acct(accountA), async (k) => sql`update usage_corrections set input_tokens_delta = -1`.execute(k)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlStateOf(asApp(acct(accountA), async (k) => sql`update usage_corrections set reason = 'rewritten'`.execute(k)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlStateOf(asApp(acct(accountA), async (k) => sql`delete from usage_corrections`.execute(k)))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  test('another account cannot see this account\'s corrections', async () => {
    const e = await insertEvent(accountA, companyA1, { inputTokens: 100 });
    await insertCorrection(accountA, companyA1, { eventId: e, input: -10 });
    const seen = await asApp(acct(accountB), async (k) => sql<{ id: string }>`select id from usage_corrections`.execute(k));
    expect(seen.rows).toHaveLength(0);
  });

  // ── the structural claims the migration's comments make ────────────────────────────────────────────────────

  test('both tables carry ENABLE + FORCE row level security', async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relname in ('account_usage_rollups', 'usage_corrections') and relnamespace = 'public'::regnamespace
    `.execute(su.kysely);
    expect(rows.rows).toHaveLength(2);
    for (const r of rows.rows) {
      expect(r.relrowsecurity, `${r.relname} must have RLS enabled`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname} must FORCE RLS (it applies to the owner too)`).toBe(true);
    }
  });

  test('the SECURITY DEFINER allowlist is still exactly three — 0051 adds a trigger function, not a fourth', async () => {
    // The migration's comment claims this. Reading it back out of the catalog is what makes the claim checkable
    // rather than a sentence nobody re-verifies.
    const rows = await sql<{ proname: string }>`
      select proname from pg_proc where pronamespace = 'public'::regnamespace and prosecdef = true order by proname
    `.execute(su.kysely);
    expect(rows.rows.map((r) => r.proname)).not.toContain('acbp_check_usage_correction');
    expect(rows.rows).toHaveLength(3);
  });

  test('the correction trigger function is NOT executable by PUBLIC', async () => {
    const rows = await sql<{ ok: boolean }>`
      select has_function_privilege('public', 'public.acbp_check_usage_correction()', 'execute') as ok
    `.execute(su.kysely);
    expect(rows.rows[0]!.ok).toBe(false);
  });
});
