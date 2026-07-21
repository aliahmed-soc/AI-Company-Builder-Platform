// ACBP-P1-008 / CDR-014 — real-PostgreSQL proof of the append-only audit store under the RESTRICTED role.
// Setup/seed runs on the superuser (owner) connection; every isolation/immutability assertion runs on a
// second pool connected as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner) so RLS + grants actually apply.
// Skips when ACBP_TEST_DATABASE_URL is unset; never mocked. Self-cleaning; runs no migrate-down.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, withTransaction, withAccountTransaction, writeAuditEvent, type DatabaseClient } from '../index.js';
import { membershipInvited, membershipRevoked, isUlid } from '@acbp/contracts';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `audit_${'test'}_pw_1970`;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-audit-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-audit-test' }));
}

// Fixed synthetic account/actor ids (no FK on audit_events.account_id, so no account rows are needed).
const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';
const ACTOR_U = '33333333-3333-3333-3333-333333333333';

describe.skipIf(!hasTestDatabase)('audit_events append-only store (real PostgreSQL, restricted role) — ACBP-P1-008/CDR-014', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;

  beforeAll(async () => {
    su = superuserClient();
    for (const t of ['audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(su);
    expect(r.error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();
  });

  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (su) {
      try {
        await sql`alter role acbp_app nologin`.execute(su.kysely);
      } catch {
        /* best effort */
      }
      for (const t of ['audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(su);
    }
  });

  beforeEach(async () => {
    await su.kysely.deleteFrom('audit_events').execute();
  });

  /** Run `fn` as the restricted role inside a transaction with the given GUCs set transaction-locally. */
  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }

  test('the writer appends a row with server-bound fields, readable only within its own account', async () => {
    const eventId = await withAccountTransaction(app, { accountId: ACCOUNT_A, actorId: ACTOR_U }, (s) => writeAuditEvent(s, membershipInvited({ membershipId: 'm_abc', role: 'viewer' })));
    expect(isUlid(eventId)).toBe(true);

    // Read back under account A: exactly the row we wrote, with server-bound account/actor/id/time + payload.
    const rowsA = await withAccountTransaction(app, { accountId: ACCOUNT_A, actorId: ACTOR_U }, (s) => s.db.selectFrom('audit_events').selectAll().execute());
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]).toMatchObject({ event_id: eventId, name: 'membership.invited', schema_version: 1, account_id: ACCOUNT_A, actor_type: 'user', actor_id: ACTOR_U, subject_type: 'membership', subject_id: 'm_abc', outcome: 'success' });
    expect(rowsA[0]?.payload).toEqual({ role: 'viewer' });
    expect(rowsA[0]?.occurred_at).toBeInstanceOf(Date);

    // Account B sees NOTHING (RLS isolation) — no cross-account audit visibility, no existence oracle.
    const rowsB = await withAccountTransaction(app, { accountId: ACCOUNT_B, actorId: ACTOR_U }, (s) => s.db.selectFrom('audit_events').selectAll().execute());
    expect(rowsB).toHaveLength(0);
  });

  test('append-only: UPDATE, DELETE, and TRUNCATE are all denied to the restricted role (invariant 11)', async () => {
    await withAccountTransaction(app, { accountId: ACCOUNT_A, actorId: ACTOR_U }, (s) => writeAuditEvent(s, membershipRevoked({ membershipId: 'm_del', role: 'owner' })));

    await expect(asApp({ 'app.current_account': ACCOUNT_A }, (k) => sql`update audit_events set outcome = 'blocked'`.execute(k))).rejects.toThrow();
    await expect(asApp({ 'app.current_account': ACCOUNT_A }, (k) => sql`delete from audit_events`.execute(k))).rejects.toThrow();
    await expect(asApp({ 'app.current_account': ACCOUNT_A }, (k) => sql`truncate audit_events`.execute(k))).rejects.toThrow();

    // The row is still present + unchanged after the failed mutation attempts.
    const rows = await withAccountTransaction(app, { accountId: ACCOUNT_A, actorId: ACTOR_U }, (s) => s.db.selectFrom('audit_events').selectAll().execute());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('success');
  });

  test('fail-closed: with no account GUC, an INSERT WITH CHECK fails and a SELECT returns nothing', async () => {
    // No app.current_account set → account_id::text = nullif('', '') = NULL → WITH CHECK false → rejected.
    await expect(
      asApp({}, (k) => sql`insert into audit_events (event_id, name, schema_version, account_id, actor_type, subject_type, subject_id, outcome) values ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'membership.invited', 1, ${ACCOUNT_A}::uuid, 'user', 'membership', 'm', 'success')`.execute(k)),
    ).rejects.toThrow();
    // Seed one row (as owner) and confirm the restricted role with no GUC sees nothing.
    await withAccountTransaction(app, { accountId: ACCOUNT_A, actorId: ACTOR_U }, (s) => writeAuditEvent(s, membershipInvited({ membershipId: 'm_x', role: 'viewer' })));
    const seen = await asApp({}, (k) => k.selectFrom('audit_events').selectAll().execute());
    expect(seen).toHaveLength(0);
  });

  test('forged account: inserting a row for another account fails the WITH CHECK bind', async () => {
    // Scope is account A, but the row claims account B → WITH CHECK (account_id = current_account) fails.
    await expect(
      asApp({ 'app.current_account': ACCOUNT_A }, (k) => sql`insert into audit_events (event_id, name, schema_version, account_id, actor_type, subject_type, subject_id, outcome) values ('01ARZ3NDEKTSV4RRFFQ69G5FB0', 'membership.invited', 1, ${ACCOUNT_B}::uuid, 'user', 'membership', 'm', 'success')`.execute(k)),
    ).rejects.toThrow();
  });

  test('catalog/ACL: acbp_app has INSERT+SELECT but NOT UPDATE/DELETE; FORCE RLS on; exactly two policies', async () => {
    const grants = await sql<{ privilege_type: string }>`select privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'audit_events'`.execute(su.kysely);
    const privs = grants.rows.map((r) => r.privilege_type).sort();
    expect(privs).toEqual(['INSERT', 'SELECT']);

    const rel = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'audit_events'`.execute(su.kysely);
    expect(rel.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const policies = await sql<{ policyname: string; cmd: string }>`select policyname, cmd from pg_policies where tablename = 'audit_events' order by policyname`.execute(su.kysely);
    expect(policies.rows.map((r) => r.policyname).sort()).toEqual(['audit_events_insert', 'audit_events_select']);
    expect(policies.rows.some((r) => r.cmd === 'UPDATE' || r.cmd === 'DELETE')).toBe(false);

    // The restricted role must not be able to bypass RLS.
    const roleAttrs = await sql<{ rolbypassrls: boolean; rolsuperuser: boolean }>`select rolbypassrls, rolsuperuser from pg_roles where rolname = 'acbp_app'`.execute(su.kysely);
    expect(roleAttrs.rows[0]).toEqual({ rolbypassrls: false, rolsuperuser: false });
  });

  test('idempotency key is unique: a duplicate key is rejected', async () => {
    await withAccountTransaction(app, { accountId: ACCOUNT_A, actorId: ACTOR_U }, (s) => writeAuditEvent(s, membershipInvited({ membershipId: 'm_1', role: 'viewer' }), { idempotencyKey: 'idem-1' }));
    await expect(
      withAccountTransaction(app, { accountId: ACCOUNT_A, actorId: ACTOR_U }, (s) => writeAuditEvent(s, membershipInvited({ membershipId: 'm_2', role: 'viewer' }), { idempotencyKey: 'idem-1' })),
    ).rejects.toThrow();
  });
});
