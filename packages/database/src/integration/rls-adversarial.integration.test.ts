// ACBP-P1-006 / CDR-013 — catalog audit + adversarial restricted-role suite. Proves, from the PostgreSQL
// system catalogs, that the role/RLS/function security model is exactly as specified, and that a hostile
// `acbp_app` session cannot cross tenants, escalate, or tamper with the security objects. Setup/seed runs
// on the superuser connection; every adversarial assertion runs on a second pool connected as `acbp_app`.
// Skips when ACBP_TEST_DATABASE_URL is unset; hosted CI runs it zero-skip.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_PW = `rls_${'test'}_pw_1970`;
const PROTECTED = ['accounts', 'account_profiles', 'memberships'] as const;
const BOOTSTRAP_FNS = ['acbp_accept_invite', 'acbp_provision_account', 'acbp_resolve_own_membership'] as const;

function su(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-adv-su' }));
}
function appClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_PW;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_APP_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-adv-app' }, { role: 'app' }));
}

let seq = 0;
async function seedAccount(admin: DatabaseClient): Promise<{ userId: string; accountId: string }> {
  seq += 1;
  const user = await admin.kysely.insertInto('users').values({ provider: 'clerk', provider_instance_id: 'ins_a', provider_user_id: `adv_${seq}`, primary_email: `adv${seq}@example.com`, email_verified: true, provider_updated_at: new Date().toISOString() }).returning('id').executeTakeFirstOrThrow();
  const acct = await admin.kysely.insertInto('accounts').values({ created_by_user_id: user.id }).returning('id').executeTakeFirstOrThrow();
  await admin.kysely.insertInto('account_profiles').values({ account_id: acct.id }).execute();
  await admin.kysely.insertInto('memberships').values({ account_id: acct.id, member_user_id: user.id, role: 'owner', status: 'active', accepted_at: new Date().toISOString() }).execute();
  return { userId: user.id, accountId: acct.id };
}

describe.skipIf(!hasTestDatabase)('RLS catalog audit + adversarial suite (real PostgreSQL) — ACBP-P1-006/CDR-013', () => {
  let admin: DatabaseClient;
  let app: DatabaseClient;

  beforeAll(async () => {
    admin = su();
    for (const t of ['interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await admin.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(admin);
    expect(r.error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_PW)}`.execute(admin.kysely);
    app = appClient();
  });
  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (admin) {
      try {
        await sql`alter role acbp_app nologin`.execute(admin.kysely);
      } catch {
        /* best effort */
      }
      for (const t of ['interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await admin.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(admin);
    }
  });

  /** Run as acbp_app with the given GUCs set transaction-locally. */
  async function asApp<T>(gucs: Record<string, string>, fn: (db: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }

  // ── Catalog: role attributes ──────────────────────────────────────────────────────────────────────
  test('acbp_app is NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB, and not a member of any owner role', async () => {
    const r = await sql<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>`select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = 'acbp_app'`.execute(admin.kysely);
    expect(r.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    const memberships = await sql<{ n: number }>`select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'acbp_app'`.execute(admin.kysely);
    expect(memberships.rows[0]?.n).toBe(0); // acbp_app inherits no other role
  });

  test('acbp_app owns no protected table and no bootstrap function', async () => {
    const tblOwners = await sql<{ tablename: string; tableowner: string }>`select tablename, tableowner from pg_tables where tablename = any(${sql.val([...PROTECTED])})`.execute(admin.kysely);
    for (const row of tblOwners.rows) expect(row.tableowner).not.toBe('acbp_app');
    const fnOwners = await sql<{ proname: string; owner: string }>`select p.proname, (select rolname from pg_roles where oid = p.proowner) as owner from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'acbp\\_%'`.execute(admin.kysely);
    for (const row of fnOwners.rows) expect(row.owner).not.toBe('acbp_app');
  });

  // ── Catalog: tables have ENABLE + FORCE RLS ─────────────────────────────────────────────────────────
  test('all three protected tables have ENABLE + FORCE row-level security', async () => {
    const r = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname = any(${sql.val([...PROTECTED])}) and relkind = 'r'`.execute(admin.kysely);
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  test('exactly the intended policies exist per table and command (no unintended/permissive policy)', async () => {
    const r = await sql<{ tablename: string; policyname: string; cmd: string; permissive: string }>`select tablename, policyname, cmd, permissive from pg_policies where tablename = any(${sql.val([...PROTECTED])}) order by tablename, policyname`.execute(admin.kysely);
    const got = r.rows.map((x) => `${x.tablename}.${x.policyname}:${x.cmd}`).sort();
    expect(got).toEqual(
      [
        'accounts.accounts_select:SELECT',
        'accounts.accounts_update:UPDATE',
        'account_profiles.account_profiles_select:SELECT',
        'account_profiles.account_profiles_update:UPDATE',
        'memberships.memberships_insert:INSERT',
        'memberships.memberships_select:SELECT',
        'memberships.memberships_update:UPDATE',
      ].sort(),
    );
    // No INSERT/DELETE policy on accounts/account_profiles; no DELETE on memberships (creation/deletion is
    // bootstrap-only / unsupported). Confirm there is no ALL-command or DELETE policy anywhere.
    expect(r.rows.some((x) => x.cmd === 'DELETE' || x.cmd === 'ALL')).toBe(false);
  });

  // ── Catalog: bootstrap functions ────────────────────────────────────────────────────────────────────
  test('exactly three SECURITY DEFINER functions, each with a fixed search_path and no PUBLIC execute', async () => {
    const fns = await sql<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>`select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'acbp\\_%' order by p.proname`.execute(admin.kysely);
    expect(fns.rows.map((x) => x.proname)).toEqual([...BOOTSTRAP_FNS]);
    for (const f of fns.rows) {
      expect(f.prosecdef).toBe(true);
      const sp = (f.proconfig ?? []).find((c) => c.toLowerCase().startsWith('search_path='));
      expect(sp?.replace(/\s/g, '').toLowerCase()).toBe('search_path=pg_catalog,pg_temp'); // pg_temp pinned last
    }
    // pg_temp must never be FIRST (the shadowing guard); assert none is bare 'search_path=pg_temp...'.
    for (const f of fns.rows) {
      const sp = (f.proconfig ?? []).find((c) => c.toLowerCase().startsWith('search_path='));
      expect(sp?.replace(/\s/g, '').toLowerCase().startsWith('search_path=pg_temp')).toBe(false);
    }
    const grants = await sql<{ routine_name: string; grantee: string }>`select routine_name, grantee from information_schema.routine_privileges where routine_schema = 'public' and routine_name like 'acbp\\_%'`.execute(admin.kysely);
    const grantees = new Set(grants.rows.map((x) => x.grantee));
    expect(grantees.has('acbp_app')).toBe(true);
    expect(grantees.has('PUBLIC')).toBe(false);
  });

  // ── Adversarial: unfiltered access / fail-closed ────────────────────────────────────────────────────
  test('unfiltered SELECT/UPDATE with NO context affects nothing; DELETE is denied at the grant level', async () => {
    const a = await seedAccount(admin);
    const seen = await asApp({}, (db) => sql<{ n: number }>`select count(*)::int as n from accounts`.execute(db).then((x) => x.rows[0]?.n));
    expect(seen).toBe(0); // RLS hides all rows without context
    await asApp({}, (db) => sql`update accounts set plan_state = 'x'`.execute(db)); // acbp_app has UPDATE, but RLS matches 0 rows
    // acbp_app was granted NO DELETE on the protected tables — a delete is denied before RLS even applies.
    await expect(asApp({}, (db) => sql`delete from accounts`.execute(db))).rejects.toBeDefined();
    await expect(asApp({}, (db) => sql`delete from account_profiles`.execute(db))).rejects.toBeDefined();
    await expect(asApp({}, (db) => sql`delete from memberships`.execute(db))).rejects.toBeDefined();
    const still = await sql<{ plan: string; profiles: number }>`select (select plan_state from accounts where id = ${a.accountId}) as plan, (select count(*)::int from account_profiles where account_id = ${a.accountId}) as profiles`.execute(admin.kysely);
    expect(still.rows[0]).toMatchObject({ plan: 'free', profiles: 1 });
  });

  test('forged / missing / empty / malformed account GUC all deny with no cast error', async () => {
    await seedAccount(admin);
    for (const ctx of [{}, { 'app.current_account': '' }, { 'app.current_account': 'not-a-uuid' }, { 'app.current_account': '00000000-0000-0000-0000-000000000000' }]) {
      const n = await asApp(ctx, (db) => sql<{ n: number }>`select count(*)::int as n from accounts`.execute(db).then((x) => x.rows[0]?.n));
      expect(n).toBe(0);
    }
  });

  // ── Adversarial: cross-account isolation via joins / CTEs / subqueries ──────────────────────────────
  test('joins, CTEs, and subqueries cannot reveal another account', async () => {
    const a = await seedAccount(admin);
    const b = await seedAccount(admin);
    const out = await asApp({ 'app.current_account': a.accountId }, async (db) => {
      const join = await sql<{ n: number }>`select count(*)::int as n from accounts ac join account_profiles p on p.account_id = ac.id`.execute(db);
      const cte = await sql<{ n: number }>`with all_m as (select account_id from memberships) select count(*)::int as n from all_m`.execute(db);
      const sub = await sql<{ n: number }>`select count(*)::int as n from accounts where id in (select account_id from account_profiles)`.execute(db);
      return { join: join.rows[0]?.n, cte: cte.rows[0]?.n, sub: sub.rows[0]?.n };
    });
    expect(out).toEqual({ join: 1, cte: 1, sub: 1 }); // only account A visible in every shape
    void b;
  });

  test('multi-row UPDATE affects only the current account', async () => {
    const a = await seedAccount(admin);
    const b = await seedAccount(admin);
    await asApp({ 'app.current_account': a.accountId }, (db) => sql`update accounts set plan_state = 'pro'`.execute(db));
    const states = await sql<{ id: string; plan_state: string }>`select id, plan_state from accounts where id = any(${sql.val([a.accountId, b.accountId])})`.execute(admin.kysely);
    expect(states.rows.find((r) => r.id === a.accountId)?.plan_state).toBe('pro');
    expect(states.rows.find((r) => r.id === b.accountId)?.plan_state).toBe('free'); // untouched
  });

  test('account id / membership account cannot be reassigned to another account (WITH CHECK)', async () => {
    const a = await seedAccount(admin);
    const b = await seedAccount(admin);
    await expect(asApp({ 'app.current_account': a.accountId }, (db) => sql`update accounts set id = ${b.accountId} where id = ${a.accountId}`.execute(db))).rejects.toBeDefined();
    await expect(asApp({ 'app.current_account': a.accountId }, (db) => sql`update memberships set account_id = ${b.accountId}`.execute(db))).rejects.toBeDefined();
  });

  // ── Adversarial: privilege / escalation attempts ────────────────────────────────────────────────────
  test('acbp_app cannot SET ROLE, CREATE ROLE, ALTER the functions/policies/tables', async () => {
    await expect(asApp({}, (db) => sql`set role postgres`.execute(db))).rejects.toBeDefined();
    await expect(asApp({}, (db) => sql`create role attacker_role login`.execute(db))).rejects.toBeDefined();
    await expect(asApp({}, (db) => sql`alter function public.acbp_resolve_own_membership(uuid, uuid) security invoker`.execute(db))).rejects.toBeDefined();
    await expect(asApp({}, (db) => sql`drop policy accounts_select on public.accounts`.execute(db))).rejects.toBeDefined();
    await expect(asApp({}, (db) => sql`alter table public.accounts no force row level security`.execute(db))).rejects.toBeDefined();
  });

  test('a self-GRANT does not escalate (PostgreSQL grants nothing without grant option; DELETE stays denied)', async () => {
    // GRANT without grant option is a no-op warning (not an error), so it resolves — but it confers nothing:
    // acbp_app still has no DELETE privilege afterward, and has no grant option on the protected tables.
    await asApp({}, (db) => sql`grant all on public.accounts to acbp_app`.execute(db)).catch(() => undefined);
    await expect(asApp({}, (db) => sql`delete from accounts`.execute(db))).rejects.toBeDefined();
    const grantable = await sql<{ n: number }>`select count(*)::int as n from information_schema.role_table_grants where grantee = 'acbp_app' and table_name = any(${sql.val([...PROTECTED])}) and is_grantable = 'YES'`.execute(admin.kysely);
    expect(grantable.rows[0]?.n).toBe(0); // no grant option on any protected table
  });

  test('acbp_app cannot directly mutate a pending invite it has no context for (RLS hides it)', async () => {
    const a = await seedAccount(admin);
    await admin.kysely.insertInto('memberships').values({ account_id: a.accountId, role: 'viewer', status: 'invited', invited_email: 'p@example.com', invite_token_hash: 'h_adv' }).execute();
    await asApp({}, (db) => sql`update memberships set status = 'active' where invite_token_hash = 'h_adv'`.execute(db));
    const row = await sql<{ status: string }>`select status from memberships where invite_token_hash = 'h_adv'`.execute(admin.kysely);
    expect(row.rows[0]?.status).toBe('invited'); // untouched
  });

  // ── Adversarial: pool / transaction leakage + concurrency ──────────────────────────────────────────
  test('context does not leak after commit or rollback, and concurrent account transactions stay isolated', async () => {
    const a = await seedAccount(admin);
    const b = await seedAccount(admin);
    // commit path
    await asApp({ 'app.current_account': a.accountId }, (db) => sql`select 1`.execute(db));
    expect(await asApp({}, (db) => sql<{ n: number }>`select count(*)::int as n from accounts`.execute(db).then((x) => x.rows[0]?.n))).toBe(0);
    // rollback path
    await expect(asApp({ 'app.current_account': a.accountId }, async (db) => {
      await sql`select 1`.execute(db);
      throw new Error('boom');
    })).rejects.toBeDefined();
    expect(await asApp({}, (db) => sql<{ n: number }>`select count(*)::int as n from accounts`.execute(db).then((x) => x.rows[0]?.n))).toBe(0);
    // concurrency
    const [ra, rb] = await Promise.all([
      asApp({ 'app.current_account': a.accountId }, (db) => sql<{ id: string }>`select id from accounts`.execute(db).then((x) => x.rows.map((r) => r.id))),
      asApp({ 'app.current_account': b.accountId }, (db) => sql<{ id: string }>`select id from accounts`.execute(db).then((x) => x.rows.map((r) => r.id))),
    ]);
    expect(ra).toEqual([a.accountId]);
    expect(rb).toEqual([b.accountId]);
  });
});
