// ACBP-P6-009 / CDR-073 — the reconciliation advisory lock, on real PostgreSQL.
//
// WHY THIS FILE EXISTS. The lock (`lockAccountPeriodForReconcile`) is the ticket's ONLY concurrency control, and
// an independent review found it had no test at all: deleting the call left every suite in the repo green. That
// is the same shape as the other defects this ticket kept producing — a control whose presence nothing measures.
// `CLAUDE.md` also requires real-PostgreSQL tests for race behaviour, which makes this mandatory rather than
// nice to have.
//
// WHAT THE LOCK PREVENTS. Reconciliation reads the stored projection, recomputes from the ledger, and writes the
// repair. Two of those interleaved would let the slower one compute from an older moment and then overwrite a
// newer, correct projection — restoring a wrong total that the first run had just fixed, and reporting "no
// drift" while doing it.
//
// HOW IT IS PROVEN, and why not by simply running two reconciliations at once: two concurrent calls both succeed
// whether or not the lock exists, so that proves nothing. Instead a separate connection takes the SAME advisory
// lock and holds it, and the real service call must then BLOCK. Remove the lock from the service and it stops
// blocking, which fails the assertion.
//
// Skips without ACBP_TEST_DATABASE_URL — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { closeDatabase, migrateToLatest, withTransaction, type DatabaseClient } from '@acbp/database';
import { reconcileAccountUsageRollup } from './usage-rollup-service.js';
import { hasTestDatabase, createSeedClient, createAppClient, enableAppLogin, disableAppLogin } from '../tenancy/rls-integration-support.js';

const ALL = ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'usage_corrections', 'account_usage_rollups', 'usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

const PERIOD = '2026-08-01';
const IN_PERIOD = '2026-08-14T10:00:00.000Z';
/** Zero tolerance: any drift alerts. The VALUE is the owner's (CDR-073 §3.1); a test supplies its own. */
const ZERO = { eventCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 };

/**
 * How long to wait before concluding the service is blocked.
 *
 * Deliberately far above the unblocked path's cost: an unblocked reconciliation of a one-company account
 * completes in single-digit milliseconds, so 750ms is roughly two orders of magnitude of headroom. The test
 * asserts BLOCKED, so a slow machine makes it MORE likely to pass, never flakier — the failure direction is the
 * safe one.
 */
const BLOCK_PROBE_MS = 750;

describe.skipIf(!hasTestDatabase)('reconciliation serialization (real PostgreSQL) — ACBP-P6-009/CDR-073', () => {
  let seed: DatabaseClient;
  let app: DatabaseClient;
  let owner = '';
  let accountA = '';
  let companyA1 = '';
  let seq = 0;

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
    if (app) await closeDatabase(app);
    if (seed) {
      await disableAppLogin(seed);
      for (const t of ALL) await seed.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(seed);
    }
  });

  beforeEach(async () => {
    for (const t of ['usage_corrections', 'account_usage_rollups', 'usage_events', 'company_memberships', 'company_profiles', 'companies', 'memberships', 'accounts', 'users'] as const) {
      await sql.raw(`delete from ${t}`).execute(seed.kysely);
    }
    seq += 1;
    const u = await sql<{ id: string }>`
      insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at)
      values ('clerk', 'ins_lock', ${`lockuser_${seq}`}, now()) returning id
    `.execute(seed.kysely);
    owner = u.rows[0]!.id;
    accountA = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${owner}::uuid) returning id`.execute(seed.kysely)).rows[0]!.id;
    await sql`insert into memberships (account_id, member_user_id, role, status, accepted_at) values (${accountA}::uuid, ${owner}::uuid, 'owner', 'active', now())`.execute(seed.kysely);
    companyA1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode, status) values (${accountA}::uuid, 'own_idea', 'active') returning id`.execute(seed.kysely)).rows[0]!.id;
    await sql`
      insert into usage_events (account_id, company_id, provider, model, task_class, outcome, input_tokens, output_tokens, estimated_cost_micros, fallback_used, latency_ms, created_at)
      values (${accountA}::uuid, ${companyA1}::uuid, 'synthetic', 'model-x@1', 'generation', 'ok', 100, 50, 1000, false, 7, ${IN_PERIOD}::timestamptz)
    `.execute(seed.kysely);
  });

  const reconcile = () =>
    reconcileAccountUsageRollup(app, { userId: owner, accountId: accountA, periodStart: PERIOD, threshold: ZERO });

  test('reconcile BLOCKS while another holds the (account, period) lock, and proceeds once released', async () => {
    // A separate connection takes the SAME advisory lock the service takes, with the SAME key derivation, and
    // holds it open. `pg_advisory_xact_lock` is released by COMMIT or ROLLBACK, so holding the transaction open
    // holds the lock.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withTransaction(app, async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${accountA}), hashtext(${PERIOD}))`.execute(tx.kysely);
      await held;
    });
    // Let the holder actually acquire before the service tries.
    await new Promise((r) => setTimeout(r, 150));

    // RELEASE IN `finally`, NOT AFTER THE ASSERTION. Learned by watching this test fail under a deliberate
    // mutation: the failing `expect` threw before `release()`, the holder transaction stayed open, and the next
    // three suites in the file order hung to their timeouts with 46 tests reported as skipped. A failing test
    // that also breaks unrelated suites buries its own diagnosis under noise that points somewhere else.
    const pending = reconcile();
    let outcome: 'completed' | 'blocked';
    try {
      outcome = await Promise.race([
        pending.then(() => 'completed' as const),
        new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), BLOCK_PROBE_MS)),
      ]);
    } finally {
      release();
      await holder;
    }
    expect(outcome, 'reconcile must wait behind an existing (account, period) lock — remove the lock and this completes').toBe('blocked');

    // Once the holder commits, the same call proceeds normally: the lock delays, it does not break anything.
    const result = await pending;
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.computed.eventCount).toBe(1);
    expect(result.storedExisted, 'no projection existed, so this is a MISSING rollup rather than a stale one').toBe(false);
  }, 30_000);

  test('a DIFFERENT period is not blocked by the lock — the key includes the period, not just the account', async () => {
    // Guards the other direction: a lock keyed on the account alone would serialize unrelated periods and make
    // the previous test pass for the wrong reason.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withTransaction(app, async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${accountA}), hashtext('2026-07-01'))`.execute(tx.kysely);
      await held;
    });
    await new Promise((r) => setTimeout(r, 150));

    let outcome: string;
    try {
      outcome = await Promise.race([
        reconcile().then((r) => r.status),
        new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), BLOCK_PROBE_MS)),
      ]);
    } finally {
      release();
      await holder;
    }
    expect(outcome, 'a July lock must not block an August reconciliation').toBe('ok');
  }, 30_000);
});
