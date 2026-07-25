// ACBP-P2-001 / CDR-022 — real-PostgreSQL proof of `interview_sessions` under the RESTRICTED role.
// Setup/seed runs on the superuser (owner) connection; every isolation/immutability assertion runs on a second
// pool connected as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner) so RLS + grants actually apply. Proves:
// dual-keyed company-scoped INSERT/SELECT/UPDATE (both account AND company must match — fail closed without the
// company key); IMMUTABLE identity columns at the PRIVILEGE level (no UPDATE grant on id/account/company/
// created_at); no DELETE/TRUNCATE; the CLOSED state CHECK; the started_at shape CHECK; the ONE-open-session-
// per-company partial unique index (a superseded session frees the slot); FK cascade; clean apply + down/up/
// reapply BY NAME; FORCE RLS + grant catalog; allowlist still exactly 3 SECURITY DEFINER; acbp_app
// NOBYPASSRLS/non-owner; migrations 0001–0012 present. Skips when ACBP_TEST_DATABASE_URL is unset; never mocked.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `interview_${'test'}_pw_1970`;

const ALL = ['usage_events', 'task_review_flags', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-interview-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-interview-test' }));
}

describe.skipIf(!hasTestDatabase)('interview_sessions tenancy (real PostgreSQL, restricted role) — ACBP-P2-001/CDR-022', () => {
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

  /** Insert a session row as the app role under company scope; returns its id. `now()` is inline SQL (a bound
   *  string 'now()' would not cast to timestamptz). A not_started session has a null started_at; any started
   *  state gets started_at = now() to satisfy the shape CHECK. */
  async function insertSession(a: string, c: string, state?: string): Promise<string> {
    return asApp(scope(a, c), async (k) => {
      let r: { rows: Array<{ id: string }> };
      if (state === undefined || state === 'not_started') {
        r = await sql<{ id: string }>`insert into interview_sessions (account_id, company_id, state) values (${a}::uuid, ${c}::uuid, ${state ?? 'not_started'}) returning id`.execute(k);
      } else {
        r = await sql<{ id: string }>`insert into interview_sessions (account_id, company_id, state, started_at) values (${a}::uuid, ${c}::uuid, ${state}, now()) returning id`.execute(k);
      }
      return r.rows[0]!.id;
    });
  }

  beforeAll(async () => {
    su = superuserClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(su);
    expect(r.error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();

    // FK targets: two accounts (distinct owner users — accounts_owner_unique = one personal account per user)
    // + three companies (A1, A2 under account A; B1 under account B). Owner connection.
    const u = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_iv', 'user_iv_u', now()) returning id`.execute(su.kysely);
    userU = u.rows[0]!.id;
    const v = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_iv', 'user_iv_v', now()) returning id`.execute(su.kysely);
    const userV = v.rows[0]!.id;
    const a = await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely);
    accountA = a.rows[0]!.id;
    const b = await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely);
    accountB = b.rows[0]!.id;
    const mk = async (acc: string): Promise<string> => (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${acc}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyA1 = await mk(accountA);
    companyA2 = await mk(accountA);
    companyB1 = await mk(accountB);

    // Deterministic down/up/reapply BY NAME: 0012 must drop and re-apply cleanly on top of the seeded FK data
    // (the companies/accounts survive because 0012's down only touches interview_sessions). Rolled back to just
    // below 0012 so this keeps testing 0012 when later migrations land on top.
    const down = await createMigrator(su).migrateTo('0011_platform_admins');
    expect(down.error).toBeUndefined();
    const up = await migrateToLatest(su);
    expect(up.error).toBeUndefined();
  });

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
    await sql`delete from interview_sessions`.execute(su.kysely);
  });

  test('dual-keyed INSERT/SELECT: a session is visible only under its own account+company scope', async () => {
    const s1 = await insertSession(accountA, companyA1);
    // Same company scope sees it.
    const own = await asApp(scope(accountA, companyA1), (k) => k.selectFrom('interview_sessions').selectAll().execute());
    expect(own.map((r) => r.id)).toEqual([s1]);
    // A DIFFERENT company of the SAME account does not (company key must match too — not account-only authority).
    expect(await asApp(scope(accountA, companyA2), (k) => k.selectFrom('interview_sessions').selectAll().execute())).toHaveLength(0);
    // A different account+company (foreign tenant) does not.
    expect(await asApp(scope(accountB, companyB1), (k) => k.selectFrom('interview_sessions').selectAll().execute())).toHaveLength(0);
  });

  test('fail closed WITHOUT the company key: account scope alone sees nothing and cannot insert', async () => {
    await insertSession(accountA, companyA1);
    // SELECT with only the account GUC set (no company) → RLS denies (company_id::text = '' is false).
    expect(await asApp({ 'app.current_account': accountA }, (k) => k.selectFrom('interview_sessions').selectAll().execute())).toHaveLength(0);
    // INSERT with only the account GUC → the WITH CHECK fails.
    await expect(asApp({ 'app.current_account': accountA }, (k) => sql`insert into interview_sessions (account_id, company_id) values (${accountA}::uuid, ${companyA1}::uuid)`.execute(k))).rejects.toThrow();
  });

  test('cross-tenant INSERT is refused: rows for a foreign company cannot be written under the caller scope', async () => {
    // Under account A / company A1 scope, try to write a row stamped for company B1 → WITH CHECK denies.
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into interview_sessions (account_id, company_id) values (${accountB}::uuid, ${companyB1}::uuid)`.execute(k))).rejects.toThrow();
  });

  test('dual-keyed UPDATE advances state; identity columns are IMMUTABLE at the privilege level', async () => {
    const s1 = await insertSession(accountA, companyA1, 'in_progress');
    // A legal mutable-column update succeeds under the right scope.
    await asApp(scope(accountA, companyA1), (k) => sql`update interview_sessions set state = 'waiting_for_user', updated_at = now() where id = ${s1}::uuid`.execute(k));
    const after = await asApp(scope(accountA, companyA1), (k) => k.selectFrom('interview_sessions').select(['state']).where('id', '=', s1).executeTakeFirst());
    expect(after?.state).toBe('waiting_for_user');
    // Attempting to UPDATE an identity column fails: no column UPDATE grant on company_id/account_id/id.
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update interview_sessions set company_id = ${companyA2}::uuid where id = ${s1}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update interview_sessions set account_id = ${accountB}::uuid where id = ${s1}::uuid`.execute(k))).rejects.toThrow();
  });

  test('no DELETE / TRUNCATE for the app role (regardless of scope)', async () => {
    const s1 = await insertSession(accountA, companyA1);
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from interview_sessions where id = ${s1}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`truncate table interview_sessions`.execute(k))).rejects.toThrow();
  });

  test('state CHECK: only the six canonical states are accepted', async () => {
    for (const bad of ['started', 'in-progress', 'done', 'active', '']) {
      await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into interview_sessions (account_id, company_id, state, started_at) values (${accountA}::uuid, ${companyA1}::uuid, ${bad}, now())`.execute(k))).rejects.toThrow();
    }
  });

  test('started_at shape CHECK: not_started forbids started_at; any other state requires it', async () => {
    // not_started with a started_at → rejected.
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into interview_sessions (account_id, company_id, state, started_at) values (${accountA}::uuid, ${companyA1}::uuid, 'not_started', now())`.execute(k))).rejects.toThrow();
    // in_progress with a NULL started_at → rejected.
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into interview_sessions (account_id, company_id, state, started_at) values (${accountA}::uuid, ${companyA1}::uuid, 'in_progress', null)`.execute(k))).rejects.toThrow();
    // The valid shapes are accepted.
    const notStarted = await insertSession(accountA, companyA1, 'not_started');
    expect(notStarted).toBeTruthy();
  });

  test('ONE open session per company: a second non-superseded session collides; a superseded one frees the slot', async () => {
    await insertSession(accountA, companyA1, 'in_progress');
    // A second non-superseded session for the SAME company violates the partial unique index.
    await expect(insertSession(accountA, companyA1, 'in_progress')).rejects.toThrow();
    // But a DIFFERENT company of the same account may have its own open session.
    expect(await insertSession(accountA, companyA2, 'in_progress')).toBeTruthy();
    // Superseding the first frees the slot: a new open session for company A1 is then allowed.
    const first = await asApp(scope(accountA, companyA1), (k) => k.selectFrom('interview_sessions').select(['id']).where('company_id', '=', companyA1).executeTakeFirstOrThrow());
    await asApp(scope(accountA, companyA1), (k) => sql`update interview_sessions set state = 'superseded' where id = ${first.id}::uuid`.execute(k));
    expect(await insertSession(accountA, companyA1, 'in_progress')).toBeTruthy();
  });

  test('FK cascade: deleting a company removes its interview sessions', async () => {
    // Use a throwaway company so the shared fixtures survive.
    const throwaway = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    await insertSession(accountA, throwaway, 'in_progress');
    await sql`delete from companies where id = ${throwaway}::uuid`.execute(su.kysely);
    const remaining = await sql<{ n: number }>`select count(*)::int as n from interview_sessions where company_id = ${throwaway}::uuid`.execute(su.kysely);
    expect(remaining.rows[0]?.n).toBe(0);
  });

  test('catalog: ENABLE+FORCE RLS; exactly three dual-keyed policies; least-privilege grants; 3 SECURITY DEFINER; acbp_app NOBYPASSRLS/non-owner; migrations 0001–0012', async () => {
    const rls = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'interview_sessions' and relkind = 'r'`.execute(su.kysely);
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pols = await sql<{ policyname: string; cmd: string }>`select policyname, cmd from pg_policies where tablename = 'interview_sessions' order by policyname`.execute(su.kysely);
    expect(pols.rows.map((p) => `${p.policyname}:${p.cmd}`)).toEqual(['interview_sessions_insert:INSERT', 'interview_sessions_select:SELECT', 'interview_sessions_update:UPDATE']);
    // TABLE-LEVEL grants: INSERT + SELECT only (no DELETE). The UPDATE is COLUMN-LEVEL, so it does NOT appear in
    // role_table_grants (the provisioning_steps precedent) — it is asserted separately against column_privileges.
    const grants = await sql<{ privilege_type: string }>`select distinct privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'interview_sessions' order by privilege_type`.execute(su.kysely);
    expect(grants.rows.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
    const updatableCols = await sql<{ column_name: string }>`select column_name from information_schema.column_privileges where grantee = 'acbp_app' and table_name = 'interview_sessions' and privilege_type = 'UPDATE' order by column_name`.execute(su.kysely);
    expect(updatableCols.rows.map((c) => c.column_name)).toEqual(['started_at', 'state', 'updated_at']);
    // No other role (incl. PUBLIC) holds any grant beyond acbp_app and the table owner.
    const others = await sql<{ grantee: string }>`select distinct grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = 'interview_sessions' and grantee not in ('acbp_app', (select tableowner from pg_tables where schemaname='public' and tablename='interview_sessions'))`.execute(su.kysely);
    expect(others.rows).toEqual([]);
    const definers = await sql<{ proname: string }>`select proname from pg_proc where prosecdef = true and pronamespace = 'public'::regnamespace order by proname`.execute(su.kysely);
    expect(definers.rows.map((d) => d.proname)).toEqual(['acbp_accept_invite', 'acbp_provision_account', 'acbp_resolve_own_membership']);
    const role = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`select rolbypassrls, rolsuper from pg_roles where rolname = 'acbp_app'`.execute(su.kysely);
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    // This migration is applied (not that it is the LAST or ONLY one — later tickets add migrations on top).
    const migs = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(su.kysely);
    expect(migs.rows.map((m) => m.name)).toContain('0012_interview_sessions');
    expect(migs.rows.length).toBeGreaterThanOrEqual(12);
  });
});
