// ACBP-P1-011 / CDR-017 — real-PostgreSQL proof of the membership-filtered company portfolio under the
// RESTRICTED role. Setup/seed runs on the superuser (owner) connection; every enumeration assertion runs on a
// second pool connected as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner) so RLS + grants actually apply.
//
// Proves (the trust-critical claims of Slice 2):
//   - the portfolio contains ONLY companies where the actor holds an ACTIVE company_membership — account
//     ownership alone reveals NOTHING (a company the actor's account owns but the actor is not a member of is
//     excluded), a REVOKED membership is excluded, and another account's companies never appear;
//   - the memberships RLS self-branch (member_user_id = app.current_actor) is the real gate: the same query with
//     a mismatched / absent app.current_actor returns nothing, even though the SQL WHERE names the actor;
//   - keyset order is companies.created_at DESC, companies.id DESC, with an exact microsecond tie handled by the
//     id tie-break, and the `after` keyset returns STRICTLY older rows (no overlap, no gap);
//   - created_at is surfaced as the exact microsecond epoch (no truncation), matching P1-009's temporal discipline.
// Skips when ACBP_TEST_DATABASE_URL is unset; never mocked. Self-cleaning.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { microsecondEpochToIso } from '@acbp/contracts';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, withTransaction, PortfolioRepository, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `portfolio_${'test'}_pw_1970`;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-portfolio-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-portfolio-test' }));
}

describe.skipIf(!hasTestDatabase)('company portfolio (real PostgreSQL, restricted role) — ACBP-P1-011/CDR-017', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let userU = '';
  let userV = '';
  let accountA = '';
  let accountB = '';

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const acct = (id: string) => ({ 'app.current_account': id });
  const acctActor = (a: string, actor: string) => ({ 'app.current_account': a, 'app.current_actor': actor });
  const acctCo = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });

  /** Create a company under account scope, set its created_at exactly (superuser), and (optionally) add a
   *  company membership for a user with a role + status. Returns the company id. */
  async function seedCompany(accountId: string, createdAtIso: string, membership?: { userId: string; role: string; status?: string }): Promise<string> {
    const id = await asApp(acct(accountId), async (k) => {
      const r = await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountId}::uuid, 'own_idea') returning id`.execute(k);
      return r.rows[0]!.id;
    });
    // Pin created_at exactly (owner bypasses RLS) so ordering/tie-breaks are deterministic.
    await sql`update companies set created_at = ${createdAtIso}::timestamptz where id = ${id}::uuid`.execute(su.kysely);
    if (membership) {
      const status = membership.status ?? 'active';
      await asApp(acctCo(accountId, id), (k) =>
        sql`insert into company_memberships (account_id, company_id, member_user_id, role, status) values (${accountId}::uuid, ${id}::uuid, ${membership.userId}::uuid, ${membership.role}, ${status})`.execute(k),
      );
    }
    return id;
  }

  beforeAll(async () => {
    su = superuserClient();
    for (const t of ['usage_events', 'task_dependencies', 'tasks', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(su);
    expect(r.error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();

    const u = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_test', 'user_u', now()) returning id`.execute(su.kysely);
    userU = u.rows[0]!.id;
    const v = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_test', 'user_v', now()) returning id`.execute(su.kysely);
    userV = v.rows[0]!.id;
    const a = await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely);
    accountA = a.rows[0]!.id;
    const b = await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely);
    accountB = b.rows[0]!.id;
  });

  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (su) {
      try {
        await sql`alter role acbp_app nologin`.execute(su.kysely);
      } catch {
        /* best effort */
      }
      for (const t of ['usage_events', 'task_dependencies', 'tasks', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(su);
    }
  });

  beforeEach(async () => {
    await su.kysely.deleteFrom('company_memberships').execute();
    await su.kysely.deleteFrom('company_profiles').execute();
    await su.kysely.deleteFrom('companies').execute();
  });

  test('lists ONLY active-membership companies — account ownership, revoked, and other-account rows are excluded', async () => {
    const coEarly = await seedCompany(accountA, '2026-01-01T00:00:00.000000Z', { userId: userU, role: 'owner' });
    const coLate = await seedCompany(accountA, '2026-03-01T00:00:00.500000Z', { userId: userU, role: 'viewer' });
    // Account A owns this company, but userU is NOT a company member → must be excluded (no account-owner registry view).
    await seedCompany(accountA, '2026-04-01T00:00:00.000000Z');
    // A revoked membership → excluded.
    await seedCompany(accountA, '2026-05-01T00:00:00.000000Z', { userId: userU, role: 'owner', status: 'revoked' });
    // Another account's company (userV member) → never appears for userU.
    await seedCompany(accountB, '2026-02-01T00:00:00.000000Z', { userId: userV, role: 'owner' });

    const rows = await asApp(acctActor(accountA, userU), (k) => new PortfolioRepository(k).listActiveMembershipCompanies(userU, 50));
    expect(rows.map((r) => r.company_id)).toEqual([coLate, coEarly]); // created_at DESC
    expect(rows.map((r) => r.role)).toEqual(['viewer', 'owner']);
    expect(rows.map((r) => r.status)).toEqual(['draft', 'draft']);
    // Exact microsecond preservation (no truncation), matching P1-009 temporal discipline.
    expect(microsecondEpochToIso(rows[0]!.created_at_us)).toBe('2026-03-01T00:00:00.500000Z');
    expect(microsecondEpochToIso(rows[1]!.created_at_us)).toBe('2026-01-01T00:00:00.000000Z');
    // The DTO-precursor row carries NO name (enrichment is a separate CompanyScope step).
    expect(Object.keys(rows[0]!).sort()).toEqual(['company_id', 'created_at_us', 'role', 'status']);
  });

  test('the memberships self-branch is the real gate: a mismatched/absent app.current_actor returns nothing', async () => {
    await seedCompany(accountA, '2026-01-01T00:00:00.000000Z', { userId: userU, role: 'owner' });
    // Correct actor GUC → visible.
    const ok = await asApp(acctActor(accountA, userU), (k) => new PortfolioRepository(k).listActiveMembershipCompanies(userU, 50));
    expect(ok).toHaveLength(1);
    // SQL names userU, but the GUC is userV → RLS self-branch hides the row (no cross-actor leak).
    const forgedGuc = await asApp(acctActor(accountA, userV), (k) => new PortfolioRepository(k).listActiveMembershipCompanies(userU, 50));
    expect(forgedGuc).toHaveLength(0);
    // GUC is userU but the SQL asks for userV (another user) → the WHERE excludes it too.
    const forgedArg = await asApp(acctActor(accountA, userU), (k) => new PortfolioRepository(k).listActiveMembershipCompanies(userV, 50));
    expect(forgedArg).toHaveLength(0);
    // No app.current_actor at all → self-branch cannot match → nothing.
    const noActor = await asApp(acct(accountA), (k) => new PortfolioRepository(k).listActiveMembershipCompanies(userU, 50));
    expect(noActor).toHaveLength(0);
  });

  test('keyset pagination: created_at DESC then id DESC, with an exact-microsecond tie broken by id', async () => {
    const coEarly = await seedCompany(accountA, '2026-01-01T00:00:00.000000Z', { userId: userU, role: 'owner' });
    // Two companies at the EXACT same microsecond instant → the id DESC tie-break decides their order.
    const coTie1 = await seedCompany(accountA, '2026-02-01T00:00:00.123456Z', { userId: userU, role: 'owner' });
    const coTie2 = await seedCompany(accountA, '2026-02-01T00:00:00.123456Z', { userId: userU, role: 'viewer' });
    const coLate = await seedCompany(accountA, '2026-03-01T00:00:00.000000Z', { userId: userU, role: 'owner' });
    const [tieHigh, tieLow] = [coTie1, coTie2].sort().reverse(); // id DESC

    const all = await asApp(acctActor(accountA, userU), (k) => new PortfolioRepository(k).listActiveMembershipCompanies(userU, 50));
    expect(all.map((r) => r.company_id)).toEqual([coLate, tieHigh, tieLow, coEarly]);

    // Page 1 (limit 2) then keyset-after its last row → page 2 is strictly older (no overlap, no gap).
    const page1 = await asApp(acctActor(accountA, userU), (k) => new PortfolioRepository(k).listActiveMembershipCompanies(userU, 2));
    expect(page1.map((r) => r.company_id)).toEqual([coLate, tieHigh]);
    const last = page1[page1.length - 1]!;
    const page2 = await asApp(acctActor(accountA, userU), (k) =>
      new PortfolioRepository(k).listActiveMembershipCompanies(userU, 2, { after: { createdAt: microsecondEpochToIso(last.created_at_us)!, companyId: last.company_id } }),
    );
    expect(page2.map((r) => r.company_id)).toEqual([tieLow, coEarly]);
  });
});
