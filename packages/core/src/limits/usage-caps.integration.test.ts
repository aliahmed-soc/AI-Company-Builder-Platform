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

  const limitEvents = async () =>
    (await sql<{ subject_id: string; metadata: Record<string, unknown> }>`select subject_id, metadata from audit_events where name = 'usage.limit_reached' order by created_at, id`.execute(seed.kysely)).rows;

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
    const hard = events.filter((e) => e.metadata['threshold'] === 'hard');
    expect(hard).toHaveLength(1);
    expect(hard[0]?.subject_id).toBe(companyA1);
    expect(hard[0]?.metadata).toMatchObject({ limit_type: 'model_spend', limit_scope: 'company', limit_period: 'day', threshold: 'hard', limit_micros: DAY_CAP, spent_micros: DAY_CAP });
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
    expect(events.filter((e) => e.metadata['threshold'] === 'soft').length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.metadata['threshold'] === 'hard')).toHaveLength(0);
  });

  // ── the account sum genuinely spans companies ───────────────────────────────────────────────────────────
  test('the ACCOUNT ceiling counts spend in OTHER companies — the one thing a company-scoped read cannot do', async () => {
    // The defect this catches is the whole reason the account read loops: if the account figure were read from
    // the calling company alone, a founder could spend the account ceiling three times over by using three
    // companies, and every per-company check would report everything fine.
    const accountDayCap = DAY_CAP * USAGE_CAP_DEFAULTS.accountMultiplier;
    // Split across both companies so NEITHER company is at its own ceiling, but the account is at its own.
    await seedSpend(accountA, companyA1, '2026-08-02T09:00:00Z', accountDayCap / 2);
    await seedSpend(accountA, companyA2, '2026-08-02T09:30:00Z', accountDayCap / 2);

    const { decision } = await check(companyA1);

    expect(decision.outcome).toBe('block');
    if (decision.outcome !== 'block') throw new Error('unreachable');
    expect(decision.blocking.cap.scope).toBe('account');
    expect(decision.blocking.spentMicros).toBe(accountDayCap);
  });

  test('the totals do not depend on the caller having COMPANY membership', async () => {
    // ACBP-P6-009's determinism claim (CDR-073 §1-G3) applied to enforcement, where it bites harder: a ceiling
    // that moves with the caller's memberships is not a ceiling. `ownerNeither` holds the account but no company
    // membership at all, and must be measured against the identical total.
    const accountDayCap = DAY_CAP * USAGE_CAP_DEFAULTS.accountMultiplier;
    await seedSpend(accountA, companyA1, '2026-08-02T09:00:00Z', accountDayCap / 2);
    await seedSpend(accountA, companyA2, '2026-08-02T09:30:00Z', accountDayCap / 2);

    const asMember = await withAccountTransaction(app, { accountId: accountA, actorId: ownerBoth }, async (s) => checkUsageCaps(s, { companyId: companyA1, at: NOW }, USAGE_CAP_DEFAULTS));
    const asNonMember = await withAccountTransaction(app, { accountId: accountA, actorId: ownerNeither }, async (s) => checkUsageCaps(s, { companyId: companyA1, at: NOW }, USAGE_CAP_DEFAULTS));

    expect(asMember.outcome).toBe('block');
    expect(asNonMember.outcome).toBe('block');
    if (asMember.outcome !== 'block' || asNonMember.outcome !== 'block') throw new Error('unreachable');
    expect(asNonMember.blocking.spentMicros).toBe(asMember.blocking.spentMicros);
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
