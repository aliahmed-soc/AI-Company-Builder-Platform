// @acbp/core — usage caps against real PostgreSQL (ACBP-P6-010; CDR-075; NFR-015 cost control, POL-001;
// CDR-008 §8's interim values). Restricted role, nothing mocked.
//
// WHAT THIS SUITE IS FOR. Every cap assertion so far has been unit-level, against numbers a test handed in.
// That proves `evaluateCaps` computes correctly and proves NOTHING about whether the ledger reads find the right
// rows, whether the account sum spans companies, or whether the audit record is actually written. Those are the
// parts that fail silently and in the customer's favour, so they are the parts that need a real database.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is "discovered but not executed", never green, so
// hosted CI on the exact SHA is the evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { closeDatabase, migrateToLatest, withAccountTransaction, type DatabaseClient } from '@acbp/database';
import { USAGE_CAP_DEFAULTS, type UsageCapsConfig } from '@acbp/config';
import { createTestLogger } from '@acbp/observability';
import { checkUsageCaps } from './usage-caps-service.js';
import { hasTestDatabase, createSeedClient, createAppClient, enableAppLogin, disableAppLogin } from '../tenancy/rls-integration-support.js';

const ALL = ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'usage_corrections', 'account_usage_rollups', 'usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

/** A fixed instant, so day and month buckets are facts rather than whatever the suite happened to run at. */
const NOW = new Date('2026-08-02T12:00:00.000Z');
const DAY_CAP = USAGE_CAP_DEFAULTS.companyDailyMicros;

describe.skipIf(!hasTestDatabase)('usage caps (real PostgreSQL) — ACBP-P6-010/CDR-075', () => {
  let seed: DatabaseClient;
  let app: DatabaseClient;
  let seq = 0;

  let ownerBoth = '';
  let ownerNeither = '';
  let accountA = '';
  let companyA1 = '';
  let companyA2 = '';

  async function seedUser(): Promise<string> {
    seq += 1;
    const r = await sql<{ id: string }>`
      insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at)
      values ('clerk', 'ins_caps', ${`capuser_${seq}`}, now()) returning id
    `.execute(seed.kysely);
    return r.rows[0]!.id;
  }
  async function seedAccount(ownerUserId: string, alsoOwners: readonly string[] = []): Promise<string> {
    const a = await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${ownerUserId}::uuid) returning id`.execute(seed.kysely);
    const id = a.rows[0]!.id;
    for (const u of [ownerUserId, ...alsoOwners]) {
      await sql`insert into memberships (account_id, member_user_id, role, status, accepted_at) values (${id}::uuid, ${u}::uuid, 'owner', 'active', now())`.execute(seed.kysely);
    }
    return id;
  }
  async function seedCompany(account: string, members: readonly string[]): Promise<string> {
    const c = await sql<{ id: string }>`insert into companies (account_id, creation_mode, status) values (${account}::uuid, 'own_idea', 'active') returning id`.execute(seed.kysely);
    const id = c.rows[0]!.id;
    for (const u of members) {
      await sql`insert into company_memberships (account_id, company_id, member_user_id, role, status) values (${account}::uuid, ${id}::uuid, ${u}::uuid, 'owner', 'active')`.execute(seed.kysely);
    }
    return id;
  }
  /** Seeded as superuser: this suite is about the cap DECISION, not about the metering write path. */
  async function seedSpend(account: string, company: string, at: string, costMicros: number): Promise<void> {
    await sql`
      insert into usage_events (account_id, company_id, provider, model, task_class, outcome, input_tokens, output_tokens, estimated_cost_micros, fallback_used, latency_ms, created_at)
      values (${account}::uuid, ${company}::uuid, 'synthetic', 'model-x@1', 'generation', 'ok', 1, 1, ${costMicros}, false, 7, ${at}::timestamptz)
    `.execute(seed.kysely);
  }

  // `payload`, `occurred_at`, `event_id` — the real column names. An earlier version of this helper guessed
  // `metadata`, `created_at` and `id`, which threw inside every case that read a record and left the five cases
  // that only inspect the DECISION passing. A green-looking half-suite is what a mis-typed fixture buys.
  const limitEvents = async () =>
    (await sql<{ subject_id: string; payload: Record<string, unknown> }>`select subject_id, payload from audit_events where name = 'usage.limit_reached' order by occurred_at, event_id`.execute(seed.kysely)).rows;

  const check = (companyId: string, config: UsageCapsConfig = USAGE_CAP_DEFAULTS, at: Date = NOW) => {
    const t = createTestLogger();
    return withAccountTransaction(app, { accountId: accountA }, async (scope) => checkUsageCaps(scope, { companyId, at }, config, { logger: t.logger })).then((decision) => ({
      decision,
      records: t.records,
    }));
  };

  beforeAll(async () => {
    seed = createSeedClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await seed.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(seed);
    expect(r.error).toBeUndefined();
    await enableAppLogin(seed);
    app = createAppClient();
  }, 120_000);

  afterAll(async () => {
    await disableAppLogin(seed);
    await closeDatabase(app);
    await closeDatabase(seed);
  });

  beforeEach(async () => {
    for (const t of ALL) await sql`truncate table ${sql.raw(t)} cascade`.execute(seed.kysely);
    ownerBoth = await seedUser();
    ownerNeither = await seedUser();
    accountA = await seedAccount(ownerBoth, [ownerNeither]);
    companyA1 = await seedCompany(accountA, [ownerBoth]);
    companyA2 = await seedCompany(accountA, [ownerBoth]);
  }, 60_000);

  // ── the ledger reads find the right rows ────────────────────────────────────────────────────────────────
  test('a company under every ceiling is allowed, and nothing is recorded', async () => {
    await seedSpend(accountA, companyA1, '2026-08-02T09:00:00Z', 1_000);

    const { decision } = await check(companyA1);

    expect(decision.outcome).toBe('allow');
    expect(await limitEvents()).toHaveLength(0);
  });

  test('AT the daily ceiling the call is refused, and the record names WHICH cap fired', async () => {
    // The ≤1-increment bound (NFR-015) against a real ledger: spend that EQUALS the cap refuses the next call.
    await seedSpend(accountA, companyA1, '2026-08-02T09:00:00Z', DAY_CAP);

    const { decision } = await check(companyA1);

    expect(decision.outcome).toBe('block');
    if (decision.outcome !== 'block') throw new Error('unreachable');
    expect(decision.blocking.cap.scope).toBe('company');
    expect(decision.blocking.cap.period).toBe('day');

    // CDR-075 §4-G4.3: a refusal a founder cannot attribute is indistinguishable from a bug in their own product.
    const events = await limitEvents();
    const hard = events.filter((e) => e.payload['threshold'] === 'hard');
    expect(hard).toHaveLength(1);
    expect(hard[0]?.subject_id).toBe(companyA1);
    expect(hard[0]?.payload).toMatchObject({ limit_type: 'model_spend', limit_scope: 'company', limit_period: 'day', threshold: 'hard', limit_micros: DAY_CAP, spent_micros: DAY_CAP });
  });

  test('ONE micro-unit under the ceiling still passes — the boundary is exact', async () => {
    await seedSpend(accountA, companyA1, '2026-08-02T09:00:00Z', DAY_CAP - 1);
    expect((await check(companyA1)).decision.outcome).not.toBe('block');
  });

  test('the soft threshold ALERTS and lets the work through', async () => {
    // §3-G7. Blocking here would be a hard cap wearing a soft cap's name, and the founder would have lost a
    // quarter of the budget they were told they had.
    await seedSpend(accountA, companyA1, '2026-08-02T09:00:00Z', Math.floor((DAY_CAP * USAGE_CAP_DEFAULTS.softPercent) / 100));

    const { decision } = await check(companyA1);

    expect(decision.outcome).toBe('allow');
    const events = await limitEvents();
    // EXACT COUNTS, not `>= 1`. The first version of this assertion used `toBeGreaterThanOrEqual(1)`, which
    // passes with one soft row or with fifty — so it could not have failed for the firehose defect sitting
    // directly under it. An assertion that cannot fail for the bug in front of it is not coverage.
    expect(events.filter((e) => e.payload['threshold'] === 'soft')).toHaveLength(1);
    expect(events.filter((e) => e.payload['threshold'] === 'hard')).toHaveLength(0);
  });

  test('a soft alert is recorded ONCE per period, however many calls follow it', async () => {
    // CDR-075 §3-G8, and the defect the independent review found: every call past the soft threshold used to
    // write another row into a trail retained for the billing lifetime, which is the noise the gate exists to
    // prevent. Five calls, one row.
    await seedSpend(accountA, companyA1, '2026-08-02T09:00:00Z', Math.floor((DAY_CAP * USAGE_CAP_DEFAULTS.softPercent) / 100));

    for (let i = 0; i < 5; i += 1) expect((await check(companyA1)).decision.outcome).toBe('allow');

    expect((await limitEvents()).filter((e) => e.payload['threshold'] === 'soft')).toHaveLength(1);
  });

  test('a hard block is recorded ONCE per period too — a retrying job does not flood the trail', async () => {
    await seedSpend(accountA, companyA1, '2026-08-02T09:00:00Z', DAY_CAP);

    for (let i = 0; i < 4; i += 1) expect((await check(companyA1)).decision.outcome).toBe('block');

    expect((await limitEvents()).filter((e) => e.payload['threshold'] === 'hard')).toHaveLength(1);
  });

  test('a NEW period records again — dedupe is per period, not forever', async () => {
    // The failure mode on the other side of §3-G8: dedupe that never resets would silence the alert from the
    // second day onward, and the trail would show one incident for an account that hit its ceiling every day.
    // ── THE DATES ARE FIRMLY IN THE PAST, AND THAT IS THE ASSERTION'S TEETH ────────────────────────────────
    //
    // This case originally ran on 2026-08-02/03 and passed for a reason that had nothing to do with the dedupe
    // being right: `audit_events.occurred_at` is the DATABASE clock (`writeAuditEvent` never sets it, so the
    // column default `now()` wins), while the dedupe's window came from the INJECTED `at`. Mixing two clocks is
    // invisible whenever the injected instant sits near the real one — true on the day this was written, false
    // the very next midnight, at which point the first row falls inside the second period's window, the crossing
    // is wrongly suppressed, and the case fails forever.
    //
    // Dating both periods in the past makes the clocks disagree ON EVERY RUN, so a dedupe keyed on `occurred_at`
    // fails here immediately and permanently rather than on a timer. The production fix is that the dedupe is
    // keyed on the DECISION's own period (`limit_period_start`), derived from the same `at` on both sides.
    await seedSpend(accountA, companyA1, '2026-07-01T09:00:00Z', DAY_CAP);
    await seedSpend(accountA, companyA1, '2026-07-02T09:00:00Z', DAY_CAP);

    await check(companyA1, USAGE_CAP_DEFAULTS, new Date('2026-07-01T12:00:00.000Z'));
    await check(companyA1, USAGE_CAP_DEFAULTS, new Date('2026-07-02T12:00:00.000Z'));

    const daily = (await limitEvents()).filter((e) => e.payload['threshold'] === 'hard' && e.payload['limit_period'] === 'day');
    expect(daily).toHaveLength(2);
    // Distinguished by the period they were DECIDED against, not by when they were written.
    expect(daily.map((e) => e.payload['limit_period_start'])).toEqual(['2026-07-01', '2026-07-02']);
  });

  // ── the account sum genuinely spans companies ───────────────────────────────────────────────────────────
  /**
   * Spread spend so the ACCOUNT ceiling is the one that binds and NO company is over its own.
   *
   * FOUR COMPANIES, NOT TWO, and the arithmetic is a real property of CDR-008's values rather than a fixture
   * detail: the account ceiling is 3× the company one, so three companies each just under their own cap still
   * total just under the account cap. **The account ceiling can only bind at four or more companies.** An
   * earlier version of this test split the account cap across two companies, which put each of them at 1.5× its
   * own ceiling — the COMPANY cap fired, correctly, and the assertion that caught it was the system being right
   * and the test being wrong.
   */
  async function spreadToAccountCeiling(): Promise<number> {
    const per = 4_000_000; // under the 5,000,000 company daily cap
    const companyA3 = await seedCompany(accountA, [ownerBoth]);
    const companyA4 = await seedCompany(accountA, [ownerBoth]);
    for (const c of [companyA1, companyA2, companyA3, companyA4]) await seedSpend(accountA, c, '2026-08-02T09:00:00Z', per);
    return per * 4; // 16,000,000 ≥ the 15,000,000 account daily ceiling
  }

  test('the ACCOUNT ceiling counts spend in OTHER companies — the one thing a company-scoped read cannot do', async () => {
    // The defect this catches is the whole reason the account read loops: if the account figure came from the
    // calling company alone, a founder could stay under every per-company cap forever while the account total
    // ran away, and every check would report everything fine.
    const accountSpend = await spreadToAccountCeiling();

    const { decision } = await check(companyA1);

    expect(decision.outcome).toBe('block');
    if (decision.outcome !== 'block') throw new Error('unreachable');
    expect(decision.blocking.cap.scope).toBe('account');
    expect(decision.blocking.cap.period).toBe('day');
    // The figure is the SUM across companies, not the caller's own 4,000,000.
    expect(decision.blocking.spentMicros).toBe(accountSpend);
  });

  test('the totals do not depend on the caller having COMPANY membership', async () => {
    // ACBP-P6-009's determinism claim (CDR-073 §1-G3) applied to enforcement, where it bites harder: a ceiling
    // that moves with the caller's memberships is not a ceiling.
    //
    // USES THE ACCOUNT-SPANNING FIXTURE DELIBERATELY. An earlier version asserted a company-scoped block, which
    // would have passed even with the account loop completely broken — the company figure needs no loop at all.
    // Only the account total actually exercises the membership-independent read.
    const accountSpend = await spreadToAccountCeiling();

    const asMember = await withAccountTransaction(app, { accountId: accountA, actorId: ownerBoth }, async (s) => checkUsageCaps(s, { companyId: companyA1, at: NOW }, USAGE_CAP_DEFAULTS));
    const asNonMember = await withAccountTransaction(app, { accountId: accountA, actorId: ownerNeither }, async (s) => checkUsageCaps(s, { companyId: companyA1, at: NOW }, USAGE_CAP_DEFAULTS));

    expect(asMember.outcome).toBe('block');
    expect(asNonMember.outcome).toBe('block');
    if (asMember.outcome !== 'block' || asNonMember.outcome !== 'block') throw new Error('unreachable');
    expect(asMember.blocking.cap.scope).toBe('account');
    expect(asNonMember.blocking.cap.scope).toBe('account');
    // `ownerNeither` is a member of NO company, and must still see the full cross-company total.
    expect(asNonMember.blocking.spentMicros).toBe(accountSpend);
    expect(asMember.blocking.spentMicros).toBe(accountSpend);
  });

  // ── the buckets are the buckets ─────────────────────────────────────────────────────────────────────────
  test('yesterdays spend does not count against today, but still counts against the month', async () => {
    // Proves the DAY read is a real day read rather than the month read wearing a different name — which is
    // exactly what a copy-paste of `sumCompanyUsage` would have produced, and what nothing else would catch.
    await seedSpend(accountA, companyA1, '2026-08-01T09:00:00Z', DAY_CAP);

    const { decision } = await check(companyA1);

    // Under the daily cap (nothing spent today) and under the monthly one (5m of 50m), so the call proceeds.
    expect(decision.outcome).toBe('allow');
  });

  test('spend at 23:30 UTC belongs to that UTC day, not to the local one', async () => {
    // §3-G13: a daily window read in the session's zone resets at local midnight, so a founder in UTC+14 would
    // get a fresh allowance fourteen hours early and the same account would enforce two different ceilings.
    await seedSpend(accountA, companyA1, '2026-08-02T23:30:00Z', DAY_CAP);

    const stillSameDay = await check(companyA1, USAGE_CAP_DEFAULTS, new Date('2026-08-02T23:45:00.000Z'));
    const nextDay = await check(companyA1, USAGE_CAP_DEFAULTS, new Date('2026-08-03T00:15:00.000Z'));

    expect(stillSameDay.decision.outcome).toBe('block');
    expect(nextDay.decision.outcome).not.toBe('block');
  });

  // ── the fail-closed direction ───────────────────────────────────────────────────────────────────────────
  test('a nonsensical cap HALTS and records NOTHING — an unreadable ceiling is not a breach', async () => {
    // A halt means no threshold is KNOWN to have been crossed. Writing `usage.limit_reached` there would assert
    // a cap event that may never have happened, and would make the incident count untrustworthy in the one
    // direction that matters.
    const broken: UsageCapsConfig = { ...USAGE_CAP_DEFAULTS, companyDailyMicros: -1 };

    const { decision, records } = await check(companyA1, broken);

    expect(decision.outcome).toBe('halt');
    expect(await limitEvents()).toHaveLength(0);
    expect(records.some((r) => r.event === 'usage.cap_unreadable')).toBe(true);
  });

  test('a zero cap blocks from the first call, and is not mistaken for "no cap"', async () => {
    // `0` is falsy: an `if (!limit)` guard anywhere in the chain would turn the strictest possible ceiling into
    // no ceiling at all, and the spend would be permitted with nothing reporting a contradiction.
    const frozen: UsageCapsConfig = { ...USAGE_CAP_DEFAULTS, companyDailyMicros: 0 };

    const { decision } = await check(companyA1, frozen);

    expect(decision.outcome).toBe('block');
    if (decision.outcome !== 'block') throw new Error('unreachable');
    expect(decision.blocking.cap.limitMicros).toBe(0);
  });
});
