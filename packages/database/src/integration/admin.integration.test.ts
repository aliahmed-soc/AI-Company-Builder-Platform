// ACBP-P1-013 / CDR-019 — real-PostgreSQL proof of the platform_admins allowlist under the RESTRICTED role.
// Setup/seed runs on the superuser (owner) connection — exactly like the operational runbook's explicit
// owner-connection setup — and every visibility/privilege assertion runs as `acbp_app` (NOSUPERUSER,
// NOBYPASSRLS, non-owner). Proves: SELF-CHECK-ONLY visibility (own active/revoked row visible; ANOTHER admin's
// row invisible; an ordinary user sees no row; absent/forged actor GUC fails closed — no enumeration); the
// restricted role cannot INSERT/UPDATE/DELETE/TRUNCATE (no runtime admin management); status-shape CHECKs;
// clean apply + down/up/reapply; no default admin row; FORCE RLS; exactly 3 SECURITY DEFINER; acbp_app
// NOBYPASSRLS/non-owner. Skips when ACBP_TEST_DATABASE_URL is unset; never mocked. Self-cleaning.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, migrateDown, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `admin_${'test'}_pw_1970`;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-admin-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-admin-test' }));
}

describe.skipIf(!hasTestDatabase)('platform_admins allowlist (real PostgreSQL, restricted role) — ACBP-P1-013/CDR-019', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let adminA = '';
  let adminRevoked = '';
  let ordinaryUser = '';

  const ALL = ['platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const actor = (id: string) => ({ 'app.current_actor': id });

  async function seedUser(tag: string): Promise<string> {
    const r = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_adm', ${tag}, now()) returning id`.execute(su.kysely);
    return r.rows[0]!.id;
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

    adminA = await seedUser('adm_a');
    adminRevoked = await seedUser('adm_r');
    ordinaryUser = await seedUser('adm_u');
    // OPERATIONAL SETUP (owner connection — the runbook path; no application wrapper exists or is used).
    await sql`insert into platform_admins (user_id) values (${adminA}::uuid)`.execute(su.kysely);
    await sql`insert into platform_admins (user_id, status, revoked_at) values (${adminRevoked}::uuid, 'revoked', now())`.execute(su.kysely);

    // Deterministic down/up/reapply against this population: 0011 must drop and re-apply cleanly (the admin
    // rows are recreated by the operational path afterwards — the migration itself never seeds anything).
    const down = await migrateDown(su);
    expect(down.error).toBeUndefined();
    const up = await migrateToLatest(su);
    expect(up.error).toBeUndefined();
    await sql`insert into platform_admins (user_id) values (${adminA}::uuid)`.execute(su.kysely);
    await sql`insert into platform_admins (user_id, status, revoked_at) values (${adminRevoked}::uuid, 'revoked', now())`.execute(su.kysely);
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

  test('the migration seeds NOTHING: no default admin exists after a clean apply (down/up left only the operational rows)', async () => {
    const rows = await su.kysely.selectFrom('platform_admins').selectAll().execute();
    expect(rows.map((r) => r.user_id).sort()).toEqual([adminA, adminRevoked].sort()); // exactly the runbook-seeded rows
  });

  test('SELF-CHECK ONLY: an actor sees exactly their own row; another admin/ordinary/absent/forged actor sees nothing', async () => {
    // The admin sees their own (active) row — and ONLY it (the revoked admin's row is invisible to them).
    const own = await asApp(actor(adminA), (k) => k.selectFrom('platform_admins').selectAll().execute());
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ user_id: adminA, status: 'active' });
    // The revoked admin sees their own row with the truthful revoked status.
    const revoked = await asApp(actor(adminRevoked), (k) => k.selectFrom('platform_admins').selectAll().execute());
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.status).toBe('revoked');
    // An ordinary user sees NO row (they simply have none — and cannot see anyone else's).
    expect(await asApp(actor(ordinaryUser), (k) => k.selectFrom('platform_admins').selectAll().execute())).toHaveLength(0);
    // No actor GUC at all → fail closed (no enumeration possible).
    expect(await asApp({}, (k) => k.selectFrom('platform_admins').selectAll().execute())).toHaveLength(0);
    // A forged non-uuid actor value denies safely with no cast error and no rows.
    expect(await asApp(actor('not-a-uuid'), (k) => k.selectFrom('platform_admins').selectAll().execute())).toHaveLength(0);
    // Even an unfiltered COUNT under a valid admin actor sees only the self row (RLS, not the WHERE, confines).
    const n = await asApp(actor(adminA), async (k) => (await sql<{ n: number }>`select count(*)::int as n from platform_admins`.execute(k)).rows[0]?.n);
    expect(n).toBe(1);
  });

  test('NO runtime management: acbp_app cannot INSERT, UPDATE, DELETE or TRUNCATE (regardless of GUCs)', async () => {
    await expect(asApp(actor(adminA), (k) => sql`insert into platform_admins (user_id) values (${ordinaryUser}::uuid)`.execute(k))).rejects.toThrow();
    await expect(asApp(actor(adminA), (k) => sql`update platform_admins set status = 'revoked', revoked_at = now() where user_id = ${adminA}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(actor(adminA), (k) => sql`delete from platform_admins`.execute(k))).rejects.toThrow();
    await expect(asApp(actor(adminA), (k) => sql`truncate table platform_admins`.execute(k))).rejects.toThrow();
  });

  test('status-shape CHECKs: closed status set; active forbids revoked_at; revoked requires revoked_at', async () => {
    await expect(sql`insert into platform_admins (user_id, status) values (${ordinaryUser}::uuid, 'suspended')`.execute(su.kysely)).rejects.toThrow();
    await expect(sql`insert into platform_admins (user_id, status, revoked_at) values (${ordinaryUser}::uuid, 'active', now())`.execute(su.kysely)).rejects.toThrow();
    await expect(sql`insert into platform_admins (user_id, status) values (${ordinaryUser}::uuid, 'revoked')`.execute(su.kysely)).rejects.toThrow();
  });

  test('catalog: FORCE RLS; exactly ONE self-select policy; SELECT-only grant; 3 SECURITY DEFINER; acbp_app NOBYPASSRLS/non-owner', async () => {
    const rls = await sql<{ relforcerowsecurity: boolean }>`select relforcerowsecurity from pg_class where relname = 'platform_admins' and relkind = 'r'`.execute(su.kysely);
    expect(rls.rows[0]?.relforcerowsecurity).toBe(true);
    const pols = await sql<{ policyname: string; cmd: string }>`select policyname, cmd from pg_policies where tablename = 'platform_admins'`.execute(su.kysely);
    expect(pols.rows.map((p) => `${p.policyname}:${p.cmd}`)).toEqual(['platform_admins_self_select:SELECT']);
    const grants = await sql<{ privilege_type: string }>`select distinct privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'platform_admins'`.execute(su.kysely);
    expect(grants.rows.map((g) => g.privilege_type)).toEqual(['SELECT']);
    const definers = await sql<{ n: number }>`select count(*)::int as n from pg_proc where prosecdef = true and proname like 'acbp_%'`.execute(su.kysely);
    expect(definers.rows[0]?.n).toBe(3);
    const role = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`select rolbypassrls, rolsuper from pg_roles where rolname = 'acbp_app'`.execute(su.kysely);
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });
});
