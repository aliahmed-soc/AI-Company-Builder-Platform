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
    for (const t of ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
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
      for (const t of ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
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

    // The restricted role must not be able to bypass RLS (pg_roles columns are rolbypassrls + rolsuper).
    const roleAttrs = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`select rolbypassrls, rolsuper from pg_roles where rolname = 'acbp_app'`.execute(su.kysely);
    expect(roleAttrs.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  test('idempotency key is unique: a duplicate key is rejected', async () => {
    await withAccountTransaction(app, { accountId: ACCOUNT_A, actorId: ACTOR_U }, (s) => writeAuditEvent(s, membershipInvited({ membershipId: 'm_1', role: 'viewer' }), { idempotencyKey: 'idem-1' }));
    await expect(
      withAccountTransaction(app, { accountId: ACCOUNT_A, actorId: ACTOR_U }, (s) => writeAuditEvent(s, membershipInvited({ membershipId: 'm_2', role: 'viewer' }), { idempotencyKey: 'idem-1' })),
    ).rejects.toThrow();
  });

  // ── ACBP-P1-008 Slice 4: adversarial DDL/tamper + pooled-context isolation ────────────────────────────
  test('tampering: the restricted role cannot ALTER, DROP, or DISABLE/UN-FORCE RLS on audit_events', async () => {
    await expect(asApp({}, (k) => sql`alter table audit_events add column injected text`.execute(k))).rejects.toThrow();
    await expect(asApp({}, (k) => sql`drop table audit_events`.execute(k))).rejects.toThrow();
    await expect(asApp({}, (k) => sql`alter table audit_events disable row level security`.execute(k))).rejects.toThrow();
    await expect(asApp({}, (k) => sql`alter table audit_events no force row level security`.execute(k))).rejects.toThrow();
  });

  test('tampering: the restricted role cannot DROP/ALTER the audit policies', async () => {
    await expect(asApp({}, (k) => sql`drop policy audit_events_insert on audit_events`.execute(k))).rejects.toThrow();
    await expect(asApp({}, (k) => sql`drop policy audit_events_select on audit_events`.execute(k))).rejects.toThrow();
    await expect(asApp({}, (k) => sql`create policy evil_all on audit_events for all using (true) with check (true)`.execute(k))).rejects.toThrow();
  });

  test('escalation: a self-GRANT is a no-op (UPDATE stays denied); CREATE ROLE is denied', async () => {
    // A non-owner GRANT without grant option is a NO-OP WARNING in PostgreSQL (not an error) — it grants
    // nothing. So the security property is not "GRANT throws" but "the privilege is never actually acquired".
    await asApp({}, (k) => sql`grant update on audit_events to acbp_app`.execute(k)); // no-op, resolves
    // NOCREATEROLE → creating a role is denied (a real permission error).
    await expect(asApp({}, (k) => sql`create role acbp_evil`.execute(k))).rejects.toThrow();
    // Despite the no-op grant attempt, UPDATE on audit_events remains denied to the restricted role.
    await withAccountTransaction(app, { accountId: ACCOUNT_A, actorId: ACTOR_U }, (s) => writeAuditEvent(s, membershipInvited({ membershipId: 'm_esc', role: 'viewer' })));
    await expect(asApp({ 'app.current_account': ACCOUNT_A }, (k) => sql`update audit_events set outcome = 'blocked'`.execute(k))).rejects.toThrow();
  });

  test('pooled-context isolation: sequential accounts on the same pool do not leak audit visibility', async () => {
    // Write as account A, then read as account B on the SAME app pool — B sees nothing (no GUC leak across txns).
    await withAccountTransaction(app, { accountId: ACCOUNT_A, actorId: ACTOR_U }, (s) => writeAuditEvent(s, membershipInvited({ membershipId: 'm_seq', role: 'viewer' })));
    const bSees = await withAccountTransaction(app, { accountId: ACCOUNT_B, actorId: ACTOR_U }, (s) => s.db.selectFrom('audit_events').selectAll().execute());
    expect(bSees).toHaveLength(0);
    // And A still sees exactly its own row afterwards.
    const aSees = await withAccountTransaction(app, { accountId: ACCOUNT_A, actorId: ACTOR_U }, (s) => s.db.selectFrom('audit_events').selectAll().execute());
    expect(aSees).toHaveLength(1);
    expect(aSees[0]?.account_id).toBe(ACCOUNT_A);
  });

  test('pooled-context isolation: concurrent accounts each see only their own audit rows', async () => {
    const [aRows, bRows] = await Promise.all([
      withAccountTransaction(app, { accountId: ACCOUNT_A, actorId: ACTOR_U }, async (s) => {
        await writeAuditEvent(s, membershipInvited({ membershipId: 'm_ca', role: 'viewer' }));
        return s.db.selectFrom('audit_events').selectAll().execute();
      }),
      withAccountTransaction(app, { accountId: ACCOUNT_B, actorId: ACTOR_U }, async (s) => {
        await writeAuditEvent(s, membershipRevoked({ membershipId: 'm_cb', role: 'owner' }));
        return s.db.selectFrom('audit_events').selectAll().execute();
      }),
    ]);
    expect(aRows.every((r) => r.account_id === ACCOUNT_A)).toBe(true);
    expect(bRows.every((r) => r.account_id === ACCOUNT_B)).toBe(true);
  });

  test('catalog: audit_events is owned by a non-app role; acbp_app is NOCREATEROLE, NOINHERIT, member of no role', async () => {
    const owner = await sql<{ tableowner: string }>`select tableowner from pg_tables where tablename = 'audit_events'`.execute(su.kysely);
    expect(owner.rows[0]?.tableowner).not.toBe('acbp_app');
    const attrs = await sql<{ rolcreaterole: boolean; rolinherit: boolean; rolcreatedb: boolean }>`select rolcreaterole, rolinherit, rolcreatedb from pg_roles where rolname = 'acbp_app'`.execute(su.kysely);
    expect(attrs.rows[0]).toEqual({ rolcreaterole: false, rolinherit: false, rolcreatedb: false });
    const memberships = await sql<{ n: number }>`select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'acbp_app'`.execute(su.kysely);
    expect(memberships.rows[0]?.n).toBe(0); // acbp_app inherits no role's privileges
    // No UPDATE/DELETE policy exists (append-only): only INSERT + SELECT.
    const cmds = await sql<{ cmd: string }>`select cmd from pg_policies where tablename = 'audit_events'`.execute(su.kysely);
    expect(cmds.rows.map((r) => r.cmd).sort()).toEqual(['INSERT', 'SELECT']);
    // Exactly three SECURITY DEFINER functions remain (P1-006 allowlist unchanged by P1-008).
    const definers = await sql<{ n: number }>`select count(*)::int as n from pg_proc where prosecdef = true and proname like 'acbp_%'`.execute(su.kysely);
    expect(definers.rows[0]?.n).toBe(3);
  });
});
