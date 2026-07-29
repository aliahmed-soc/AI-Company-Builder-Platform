// ACBP-P1-011 / CDR-017 §Switch isolation — real-PostgreSQL proof that "switching" (stateless URL-only
// re-resolution) leaks NO context between companies. Trust-critical: A->B->A sequential AND concurrent request
// sequences share no row/name/role/context; the same company yields DIFFERENT roles to different callers;
// transaction-local company/account GUCs clear after BOTH commit and rollback (SET LOCAL semantics) so a pooled
// connection never carries a prior request's company context; and a forged route companyId (a company the caller
// is not a member of, or one in another account) denies. Runs as `acbp_app` under FORCE RLS. Skips without
// ACBP_TEST_DATABASE_URL; never mocked.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { closeDatabase, migrateToLatest, withTransaction, type DatabaseClient, type NewUser } from '@acbp/database';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { getCompany } from './company-lifecycle.js';
import { getCompanyPortfolio } from './portfolio-service.js';
import { hasTestDatabase, createSeedClient, createAppClient, enableAppLogin, disableAppLogin } from '../tenancy/rls-integration-support.js';

const NOW = () => new Date().toISOString();
let seq = 0;
async function seedUser(seed: DatabaseClient, email: string): Promise<string> {
  seq += 1;
  const values: NewUser = { provider: 'clerk', provider_instance_id: 'ins_sw', provider_user_id: `swuser_${seq}`, primary_email: email, email_verified: true, provider_updated_at: NOW() };
  const row = await seed.kysely.insertInto('users').values(values).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

describe.skipIf(!hasTestDatabase)('portfolio switch isolation (real PostgreSQL, restricted role) — ACBP-P1-011/CDR-017', () => {
  let seed: DatabaseClient;
  let app: DatabaseClient;
  let userO: string; // account owner
  let userP: string; // second account member
  let outsiderAccount: string;
  let accountId: string;
  let alpha = '';
  let beta = '';
  let gamma = '';
  let foreign = ''; // a company in ANOTHER account

  const ALL = ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

  beforeAll(async () => {
    seed = createSeedClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await seed.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(seed);
    expect(r.error).toBeUndefined();
    await enableAppLogin(seed);
    app = createAppClient();
  });
  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (seed) {
      await disableAppLogin(seed);
      for (const t of ALL) await seed.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(seed);
    }
  });

  /** Seed a company + its v1 profile + memberships directly (superuser bypasses RLS) with a pinned created_at. */
  async function seedCompany(account: string, name: string, createdAtIso: string, members: ReadonlyArray<{ userId: string; role: string }>): Promise<string> {
    const co = await sql<{ id: string }>`insert into companies (account_id, creation_mode, status, created_at) values (${account}::uuid, 'own_idea', 'active', ${createdAtIso}::timestamptz) returning id`.execute(seed.kysely);
    const id = co.rows[0]!.id;
    await sql`insert into company_profiles (company_id, version, name) values (${id}::uuid, 1, ${name})`.execute(seed.kysely);
    for (const m of members) {
      await sql`insert into company_memberships (account_id, company_id, member_user_id, role, status) values (${account}::uuid, ${id}::uuid, ${m.userId}::uuid, ${m.role}, 'active')`.execute(seed.kysely);
    }
    return id;
  }

  beforeEach(async () => {
    for (const t of ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'users'] as const) {
      await seed.kysely.deleteFrom(t).execute();
    }
    userO = await seedUser(seed, 'owner@example.com');
    userP = await seedUser(seed, 'peer@example.com');
    const outsider = await seedUser(seed, 'outsider@example.com');
    accountId = (await provisionPersonalAccount(app, userO)).accountId;
    // userP is an active ACCOUNT member (so portfolio:read + account resolution pass for them).
    await seed.kysely.insertInto('memberships').values({ account_id: accountId, member_user_id: userP, role: 'viewer', status: 'active', accepted_at: sql<Date>`now()` }).execute();
    // A separate account with its own company — the cross-account forgery target.
    outsiderAccount = (await provisionPersonalAccount(app, outsider)).accountId;

    // userO: owner of Alpha, VIEWER of Beta. userP: OWNER of Beta, owner of Gamma. (Same company Beta, two roles.)
    alpha = await seedCompany(accountId, 'Alpha', '2026-01-01T00:00:00.000000Z', [{ userId: userO, role: 'owner' }]);
    beta = await seedCompany(accountId, 'Beta', '2026-02-01T00:00:00.000000Z', [{ userId: userO, role: 'viewer' }, { userId: userP, role: 'owner' }]);
    gamma = await seedCompany(accountId, 'Gamma', '2026-03-01T00:00:00.000000Z', [{ userId: userP, role: 'owner' }]);
    foreign = await seedCompany(outsiderAccount, 'Foreign', '2026-01-15T00:00:00.000000Z', [{ userId: outsider, role: 'owner' }]);
  });

  test('A->B->A sequential switch: each entry yields ITS OWN company, no name/status bleed', async () => {
    const a1 = await getCompany(app, { userId: userO, accountId, companyId: alpha });
    const b = await getCompany(app, { userId: userO, accountId, companyId: beta });
    const a2 = await getCompany(app, { userId: userO, accountId, companyId: alpha });
    expect(a1.status === 'ok' && a1.company.name).toBe('Alpha');
    expect(b.status === 'ok' && b.company.name).toBe('Beta');
    expect(a2.status === 'ok' && a2.company.name).toBe('Alpha'); // re-entry after B is unaffected by B's context
  });

  test('the SAME company yields different roles to different callers (role isolation via the portfolio)', async () => {
    const o = await getCompanyPortfolio(app, { userId: userO, accountId });
    const p = await getCompanyPortfolio(app, { userId: userP, accountId });
    expect(o.status).toBe('ok');
    expect(p.status).toBe('ok');
    if (o.status !== 'ok' || p.status !== 'ok') return;
    // userO: Beta(viewer, 2026-02) then Alpha(owner, 2026-01), newest-first.
    expect(o.page.items.map((i) => [i.companyId, i.name, i.role])).toEqual([
      [beta, 'Beta', 'viewer'],
      [alpha, 'Alpha', 'owner'],
    ]);
    // userP: Gamma(owner, 2026-03) then Beta(owner, 2026-02). Beta's role differs from userO's view.
    expect(p.page.items.map((i) => [i.companyId, i.name, i.role])).toEqual([
      [gamma, 'Gamma', 'owner'],
      [beta, 'Beta', 'owner'],
    ]);
  });

  test('concurrent switches are isolated: parallel entries + parallel portfolios never cross', async () => {
    // Different companies entered concurrently by the same caller resolve to their own rows (pooled-GUC isolation).
    const [ra, rb] = await Promise.all([getCompany(app, { userId: userO, accountId, companyId: alpha }), getCompany(app, { userId: userO, accountId, companyId: beta })]);
    expect(ra.status === 'ok' && ra.company.name).toBe('Alpha');
    expect(rb.status === 'ok' && rb.company.name).toBe('Beta');
    // Different callers' portfolios computed concurrently never bleed across actor GUCs.
    const [po, pp] = await Promise.all([getCompanyPortfolio(app, { userId: userO, accountId }), getCompanyPortfolio(app, { userId: userP, accountId })]);
    const ids = (r: typeof po): string[] => (r.status === 'ok' ? r.page.items.map((i) => i.companyId) : ['ERR']);
    expect(ids(po)).toEqual([beta, alpha]);
    expect(ids(pp)).toEqual([gamma, beta]);
  });

  test('a revoked selection forces reload: the SAME request that just succeeded is now coarsely denied, and the next portfolio read excludes the company (CDR-017 required behavior)', async () => {
    // Active membership → the protected company request succeeds.
    const before = await getCompany(app, { userId: userO, accountId, companyId: alpha });
    expect(before.status === 'ok' && before.company.name).toBe('Alpha');
    // The membership is revoked (e.g. by an admin) while the client still "has" alpha selected in its URL.
    await seed.kysely.updateTable('company_memberships').set({ status: 'revoked' }).where('company_id', '=', alpha).where('member_user_id', '=', userO).execute();
    // The IDENTICAL request now denies coarsely — fresh resolution, no cached scope, no fallback company.
    const after = await getCompany(app, { userId: userO, accountId, companyId: alpha });
    expect(after.status).toBe('forbidden');
    // And the next portfolio read excludes the revoked company (only Beta remains for userO).
    const p = await getCompanyPortfolio(app, { userId: userO, accountId });
    expect(p.status).toBe('ok');
    if (p.status === 'ok') expect(p.page.items.map((i) => i.companyId)).toEqual([beta]);
  });

  test('a forged route companyId denies: a non-member company and a cross-account company both 403', async () => {
    // userO is NOT a member of Gamma (only userP is) → coarse denial (selection is non-authoritative).
    expect((await getCompany(app, { userId: userO, accountId, companyId: gamma })).status).toBe('forbidden');
    // A company in ANOTHER account, addressed under this account → denied.
    expect((await getCompany(app, { userId: userO, accountId, companyId: foreign })).status).toBe('forbidden');
  });

  test('transaction-local GUCs clear after COMMIT and ROLLBACK (a pooled connection carries no prior context)', async () => {
    // Drive real company-scoped work (portfolio enrichment opens+commits per-candidate company scopes).
    await getCompanyPortfolio(app, { userId: userO, accountId });
    // A bare transaction on the same pool sees NO leaked account/company GUC after those commits.
    const afterCommit = await withTransaction(app, async (tx) => {
      const r = await sql<{ c: string | null; a: string | null }>`select current_setting('app.current_company', true) as c, current_setting('app.current_account', true) as a`.execute(tx.kysely);
      return r.rows[0]!;
    });
    expect(afterCommit.c === '' || afterCommit.c === null).toBe(true);
    expect(afterCommit.a === '' || afterCommit.a === null).toBe(true);

    // A transaction that SET LOCAL a company GUC then throws → rolled back; the GUC must not survive.
    await expect(
      withTransaction(app, async (tx) => {
        await sql`select set_config('app.current_company', ${alpha}, true)`.execute(tx.kysely);
        throw new Error('forced rollback');
      }),
    ).rejects.toBeDefined();
    const afterRollback = await withTransaction(app, async (tx) => {
      const r = await sql<{ c: string | null }>`select current_setting('app.current_company', true) as c`.execute(tx.kysely);
      return r.rows[0]!.c;
    });
    expect(afterRollback === '' || afterRollback === null).toBe(true);
  });
});
