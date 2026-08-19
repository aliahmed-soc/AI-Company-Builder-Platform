// ACBP-P6-009 / CDR-073 — the trust-critical #14 determinism suite, on real PostgreSQL.
//
// Canon, verbatim: **"Account usage equals the deterministic sum of eligible company usage."**
//
// The word doing the work is DETERMINISTIC, and the case this suite exists for is the one that would otherwise
// never be noticed: a total that is *correct-looking but caller-dependent*. If the rebuild had used
// `runInCompanyScope` — the obvious primitive, and the one every other read in this codebase uses — then an
// account owner who is not a member of every company would get a SMALLER number than another owner asking the
// same question about the same account, and neither total would look wrong. `theSameTotalRegardlessOfMembership`
// below is the assertion that pins that, and it is the reason CDR-073 §1-G3 exists.
//
// Runs as `acbp_app` under FORCE RLS through the real use case. Skips without ACBP_TEST_DATABASE_URL — a skipped
// run is never green; hosted CI on the exact SHA is the evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { closeDatabase, migrateToLatest, type DatabaseClient } from '@acbp/database';
import { rebuildAccountUsageRollup, readAccountUsageRollup } from './usage-rollup-service.js';
import { hasTestDatabase, createSeedClient, createAppClient, enableAppLogin, disableAppLogin } from '../tenancy/rls-integration-support.js';

const ALL = ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'usage_corrections', 'api_rate_limit_buckets', 'account_usage_rollups', 'usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

const PERIOD = '2026-08-01';
const IN_PERIOD = '2026-08-14T10:00:00.000Z';

describe.skipIf(!hasTestDatabase)('account usage rollup determinism (real PostgreSQL) — ACBP-P6-009/CDR-073, trust-critical #14', () => {
  let seed: DatabaseClient;
  let app: DatabaseClient;
  let seq = 0;

  // `ownerBoth` is a member of both companies; `ownerNeither` is an account owner with NO company membership at
  // all. Both must get the same account total — that pair IS the determinism claim.
  let ownerBoth = '';
  let ownerNeither = '';
  let outsider = '';
  let accountA = '';
  let accountB = '';
  let companyA1 = '';
  let companyA2 = '';
  let companyB1 = '';

  async function seedUser(): Promise<string> {
    seq += 1;
    const r = await sql<{ id: string }>`
      insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at)
      values ('clerk', 'ins_roll', ${`rolluser_${seq}`}, now()) returning id
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
  async function seedCompany(account: string, status: string, members: readonly string[]): Promise<string> {
    const c = await sql<{ id: string }>`insert into companies (account_id, creation_mode, status) values (${account}::uuid, 'own_idea', ${status}) returning id`.execute(seed.kysely);
    const id = c.rows[0]!.id;
    for (const u of members) {
      await sql`insert into company_memberships (account_id, company_id, member_user_id, role, status) values (${account}::uuid, ${id}::uuid, ${u}::uuid, 'owner', 'active')`.execute(seed.kysely);
    }
    return id;
  }
  /** Seed directly as the superuser: this suite is about the READ being deterministic, not about the write path. */
  async function seedEvent(account: string, company: string, at: string, f: { input: number; output: number; cost: number }): Promise<string> {
    const r = await sql<{ id: string }>`
      insert into usage_events (account_id, company_id, provider, model, task_class, outcome, input_tokens, output_tokens, estimated_cost_micros, fallback_used, latency_ms, created_at)
      values (${account}::uuid, ${company}::uuid, 'synthetic', 'model-x@1', 'generation', 'ok', ${f.input}, ${f.output}, ${f.cost}, false, 7, ${at}::timestamptz)
      returning id
    `.execute(seed.kysely);
    return r.rows[0]!.id;
  }

  /** Seed a compensating correction directly (superuser). Deltas are `<= 0`, bounded by the corrected event. */
  async function seedCorrection(account: string, company: string, eventId: string, d: { input: number; cost: number }): Promise<void> {
    await sql`
      insert into usage_corrections (account_id, company_id, corrects_usage_event_id, input_tokens_delta, estimated_cost_micros_delta, reason)
      values (${account}::uuid, ${company}::uuid, ${eventId}::uuid, ${d.input}, ${d.cost}, 'determinism fixture')
    `.execute(seed.kysely);
  }

  const rebuild = (userId: string, accountId: string, period = PERIOD) =>
    rebuildAccountUsageRollup(app, { userId, accountId, periodStart: period });

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
    for (const t of ['usage_corrections', 'api_rate_limit_buckets', 'account_usage_rollups', 'usage_events', 'company_memberships', 'company_profiles', 'companies', 'memberships', 'accounts', 'users'] as const) {
      await sql.raw(`delete from ${t}`).execute(seed.kysely);
    }
    ownerBoth = await seedUser();
    ownerNeither = await seedUser();
    outsider = await seedUser();
    accountA = await seedAccount(ownerBoth, [ownerNeither]);
    accountB = await seedAccount(outsider);
    companyA1 = await seedCompany(accountA, 'active', [ownerBoth]);
    companyA2 = await seedCompany(accountA, 'active', [ownerBoth]);
    companyB1 = await seedCompany(accountB, 'active', [outsider]);
  });

  test('the account total is the SUM ACROSS THE ACCOUNT\'S COMPANIES, not one company\'s', async () => {
    await seedEvent(accountA, companyA1, IN_PERIOD, { input: 100, output: 50, cost: 1000 });
    await seedEvent(accountA, companyA2, IN_PERIOD, { input: 7, output: 3, cost: 25 });

    const result = await rebuild(ownerBoth, accountA);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.figures).toEqual({ eventCount: 2, inputTokens: 107, outputTokens: 53, estimatedCostMicros: 1025 });
    expect(result.companyCount).toBe(2);
  });

  test('THE TOTAL DOES NOT DEPEND ON THE CALLER\'S COMPANY MEMBERSHIPS (CDR-073 §1-G3)', async () => {
    // `ownerNeither` is an account owner with NO company_memberships row for either company. Under
    // `runInCompanyScope` this caller would see NOTHING and the "account total" would come back 0 — a wrong
    // number that looks entirely plausible, and differs from what their co-owner sees for the same account.
    await seedEvent(accountA, companyA1, IN_PERIOD, { input: 100, output: 50, cost: 1000 });
    await seedEvent(accountA, companyA2, IN_PERIOD, { input: 7, output: 3, cost: 25 });

    const asMemberOfBoth = await rebuild(ownerBoth, accountA);
    const asMemberOfNeither = await rebuild(ownerNeither, accountA);
    expect(asMemberOfBoth.status).toBe('ok');
    expect(asMemberOfNeither.status).toBe('ok');
    if (asMemberOfBoth.status !== 'ok' || asMemberOfNeither.status !== 'ok') return;
    expect(asMemberOfNeither.figures).toEqual(asMemberOfBoth.figures);
    // ...and it is not the degenerate agreement of two zeros.
    expect(asMemberOfNeither.figures.eventCount).toBe(2);
    expect(asMemberOfNeither.companyCount).toBe(2);
  });

  test('CORRECTIONS IN EVERY COMPANY REDUCE THE TOTAL — not only the last one summed (§1-G5/G10c)', async () => {
    // WHY THIS CASE EXISTS. `sumCompanyCorrections` is confined to one company by its JOIN to the dual-keyed
    // `usage_events`, NOT by its own RLS — `usage_corrections` is account-keyed. On that reading, hoisting the
    // corrections sum out of the per-company loop looks like a harmless simplification. It is not: after the
    // loop the company GUC holds whichever company sorted last by id, so every other company's corrections
    // vanish from the total.
    //
    // Until this test, EVERY correction fixture in the repo lived in exactly one company of one account, so that
    // refactor stayed green everywhere while over-stating the bill of any multi-company account. The assertion
    // catches it whichever company happens to sort last, because both corrections must land.
    const e1 = await seedEvent(accountA, companyA1, IN_PERIOD, { input: 100, output: 50, cost: 1000 });
    const e2 = await seedEvent(accountA, companyA2, IN_PERIOD, { input: 200, output: 60, cost: 2000 });
    await seedCorrection(accountA, companyA1, e1, { input: -10, cost: -100 });
    await seedCorrection(accountA, companyA2, e2, { input: -20, cost: -200 });

    const result = await rebuild(ownerBoth, accountA);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.figures.inputTokens, 'both corrections must apply: 300 - 10 - 20').toBe(270);
    expect(result.figures.estimatedCostMicros, 'both corrections must apply: 3000 - 100 - 200').toBe(2700);
    expect(result.figures.outputTokens, 'an uncorrected lane is untouched').toBe(110);
  });

  test('a PAUSED company still counts — deactivated-company history is preserved (§1-G4)', async () => {
    // BILL-006: cancellation is company PAUSE, never deletion. A status filter in the enumeration would silently
    // rewrite history the moment a customer paused a company, and last month's invoice would change.
    await seedEvent(accountA, companyA1, IN_PERIOD, { input: 100, output: 50, cost: 1000 });
    await seedEvent(accountA, companyA2, IN_PERIOD, { input: 7, output: 3, cost: 25 });
    await sql`update companies set status = 'paused' where id = ${companyA2}::uuid`.execute(seed.kysely);

    const result = await rebuild(ownerBoth, accountA);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.figures.eventCount).toBe(2);
    expect(result.figures.inputTokens).toBe(107);
    expect(result.companyCount).toBe(2);
  });

  test('another account\'s usage NEVER contributes', async () => {
    await seedEvent(accountA, companyA1, IN_PERIOD, { input: 100, output: 50, cost: 1000 });
    await seedEvent(accountB, companyB1, IN_PERIOD, { input: 999_999, output: 999_999, cost: 999_999 });

    const result = await rebuild(ownerBoth, accountA);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.figures).toEqual({ eventCount: 1, inputTokens: 100, outputTokens: 50, estimatedCostMicros: 1000 });
  });

  test('REBUILDING TWICE IS IDEMPOTENT — one row, unchanged figures (§1-G12)', async () => {
    await seedEvent(accountA, companyA1, IN_PERIOD, { input: 100, output: 50, cost: 1000 });
    const first = await rebuild(ownerBoth, accountA);
    const second = await rebuild(ownerBoth, accountA);
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('expected ok');
    expect(second.figures).toEqual(first.figures);

    const rows = await sql<{ n: string }>`select count(*)::text as n from account_usage_rollups where account_id = ${accountA}::uuid`.execute(seed.kysely);
    expect(rows.rows[0]!.n).toBe('1'); // not 2, and the figures above are not doubled
  });

  test('events OUTSIDE the period do not contribute, on either side of the boundary', async () => {
    await seedEvent(accountA, companyA1, IN_PERIOD, { input: 100, output: 50, cost: 1000 });
    await seedEvent(accountA, companyA1, '2026-07-31T23:59:59.000Z', { input: 500, output: 500, cost: 500 });
    await seedEvent(accountA, companyA1, '2026-09-01T00:00:00.000Z', { input: 500, output: 500, cost: 500 });

    const result = await rebuild(ownerBoth, accountA);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.figures.eventCount).toBe(1);
    expect(result.figures.inputTokens).toBe(100);
    // The July event lands in July when that period is rebuilt — it is excluded, not lost.
    const july = await rebuild(ownerBoth, accountA, '2026-07-01');
    if (july.status !== 'ok') throw new Error('expected ok');
    expect(july.figures.eventCount).toBe(1);
    expect(july.figures.inputTokens).toBe(500);
  });

  test('a period with NO usage writes an explicit zero row — computed-and-zero, not missing', async () => {
    const result = await rebuild(ownerBoth, accountA);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.figures).toEqual({ eventCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 });
    const rows = await sql<{ n: string }>`select count(*)::text as n from account_usage_rollups where account_id = ${accountA}::uuid`.execute(seed.kysely);
    expect(rows.rows[0]!.n).toBe('1');
  });

  test('an account with NO companies rebuilds to zero rather than failing', async () => {
    await sql`delete from company_memberships where account_id = ${accountA}::uuid`.execute(seed.kysely);
    await sql`delete from companies where account_id = ${accountA}::uuid`.execute(seed.kysely);
    const result = await rebuild(ownerBoth, accountA);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.companyCount).toBe(0);
    expect(result.figures.eventCount).toBe(0);
  });

  test('a caller with NO ACTIVE ACCOUNT MEMBERSHIP is denied, and writes nothing', async () => {
    await seedEvent(accountA, companyA1, IN_PERIOD, { input: 100, output: 50, cost: 1000 });
    const result = await rebuild(outsider, accountA);
    expect(result.status).toBe('denied');
    const rows = await sql<{ n: string }>`select count(*)::text as n from account_usage_rollups`.execute(seed.kysely);
    expect(rows.rows[0]!.n).toBe('0');
  });

  test('a malformed period is refused BEFORE any scope is established or row written', async () => {
    for (const bad of ['2026-08-17', 'not-a-date', '', '2026-13-01']) {
      const result = await rebuild(ownerBoth, accountA, bad);
      expect(result.status, `period ${JSON.stringify(bad)} must be refused`).toBe('invalid_period');
    }
    const rows = await sql<{ n: string }>`select count(*)::text as n from account_usage_rollups`.execute(seed.kysely);
    expect(rows.rows[0]!.n).toBe('0');
  });

  /**
   * ACBP-API-011 owed item 3 (owner ruling 2026-08-19) — SEEDED invisibility, to the CDR-093 standard.
   *
   * `readAccountUsageRollup` is now reachable over HTTP (`GET /api/account/usage`), and this is the read where
   * getting it wrong is worst: a rollup spans the account's companies BY DESIGN, so RLS cannot narrow it and the
   * authorization is the only thing standing between a caller and another account's total spend. That is the
   * `readCreditLedger` review-pass-1 HIGH restated as a route.
   *
   * ⚠️ SEEDED, NOT ABSENT. Account B's rollup is really computed and really stored, and its existence is asserted
   * on the superuser connection BEFORE account A's owner is refused it. Asserting a refusal against an account
   * with no rollup would pass identically whether the authorization works or not.
   *
   * The POSITIVE CONTROL is A reading its OWN rollup successfully in the same test: without it, a read that
   * refused everybody — a broken scope, a swallowed error — would satisfy the negative and look like security.
   */
  describe('seeded cross-account invisibility of the rollup read (ACBP-API-011)', () => {
    test("account B's rollup EXISTS and account A's owner still cannot read it", async () => {
      // B's ledger and B's stored projection, built by B's OWN owner through the real use case.
      await seedEvent(accountB, companyB1, IN_PERIOD, { input: 911, output: 811, cost: 7111 });
      const bBuilt = await rebuild(outsider, accountB);
      expect(bBuilt.status, "B's rollup must be built, or the refusal below is unfalsifiable").toBe('ok');

      // A's own ledger and projection — the positive control.
      await seedEvent(accountA, companyA1, IN_PERIOD, { input: 100, output: 50, cost: 1000 });
      expect((await rebuild(ownerBoth, accountA)).status).toBe('ok');

      // BOTH ROWS ARE ON DISK, pinned by account id, before anything is read back.
      const stored = await sql<{ account_id: string }>`select account_id from account_usage_rollups order by account_id`.execute(seed.kysely);
      const accounts = stored.rows.map((s) => s.account_id);
      expect(accounts, 'both rollups must be persisted before invisibility means anything').toEqual(expect.arrayContaining([accountA, accountB]));

      // POSITIVE CONTROL: A's owner reads A's own rollup and gets A's real figures.
      const own = await readAccountUsageRollup(app, { userId: ownerBoth, accountId: accountA, periodStart: PERIOD });
      expect(own.status, "A's owner must be able to read A's own rollup, or the negative below is vacuous").toBe('ok');
      if (own.status !== 'ok') return;
      expect(own.figures).toEqual({ eventCount: 1, inputTokens: 100, outputTokens: 50, estimatedCostMicros: 1000 });

      // THE NEGATIVE: the same caller asking for account B, whose rollup demonstrably exists.
      const foreign = await readAccountUsageRollup(app, { userId: ownerBoth, accountId: accountB, periodStart: PERIOD });
      expect(foreign.status, "A's owner must not read B's rollup").not.toBe('ok');

      // NOT ONE OF B's FIGURES TRAVELS, whatever arm came back. Searched over the whole serialized result rather
      // than a field this test happens to know about — a leak through an unexpected field is still a leak.
      const body = JSON.stringify(foreign);
      for (const secret of ['911', '811', '7111']) {
        expect(body, `B's figure ${secret} must not appear in the refusal handed to A`).not.toContain(secret);
      }
    });
  });
});
