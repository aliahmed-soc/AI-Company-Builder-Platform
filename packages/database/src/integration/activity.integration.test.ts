// ACBP-P1-009 / CDR-016 — real-PostgreSQL proof of the append-only, dual-keyed activity_events projection under
// the RESTRICTED role. Setup on the superuser (owner) connection; every isolation/immutability assertion runs on
// a second pool connected as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner). Proves: dual-keyed (account +
// company) INSERT/SELECT; fail-closed on missing/forged context; append-only (no UPDATE/DELETE/TRUNCATE grant or
// policy); idempotent by event_id PK; type CHECK confined to the four company events; FORCE RLS + grant catalog;
// allowlist still exactly three SECURITY DEFINER. Skips when ACBP_TEST_DATABASE_URL is unset; never mocked.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `activity_${'test'}_pw_1970`;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-activity-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-activity-test' }));
}

// Synthetic ids (activity_events has NO FK, so no account/company rows are required).
const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';
const COMPANY_X = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const COMPANY_Y = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ACTOR_U = '33333333-3333-3333-3333-333333333333';
const U1 = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
const U2 = '01ARZ3NDEKTSV4RRFFQ69G5FA2';
const U3 = '01ARZ3NDEKTSV4RRFFQ69G5FA3';

describe.skipIf(!hasTestDatabase)('activity_events projection (real PostgreSQL, restricted role) — ACBP-P1-009/CDR-016', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const scope = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });

  /** Insert an activity row via raw SQL as the app role (the writer is exercised in Slice 3). */
  function insertActivity(k: DatabaseClient['kysely'], eventId: string, accountId: string, companyId: string, occurredAt: string, type = 'company.created') {
    return sql`insert into activity_events (event_id, account_id, company_id, activity_type, schema_version, occurred_at, actor_type, actor_id, subject_type, subject_id, payload)
      values (${eventId}, ${accountId}::uuid, ${companyId}::uuid, ${type}, 1, ${occurredAt}::timestamptz, 'user', ${ACTOR_U}::uuid, 'company', ${companyId}, '{"creation_mode":"own_idea"}'::jsonb)`.execute(k);
  }

  beforeAll(async () => {
    su = superuserClient();
    for (const t of ['activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
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
      for (const t of ['activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(su);
    }
  });

  beforeEach(async () => {
    await su.kysely.deleteFrom('activity_events').execute();
  });

  test('dual-keyed insert + read: a row is visible only under its own account AND company', async () => {
    await asApp(scope(ACCOUNT_A, COMPANY_X), (k) => insertActivity(k, U1, ACCOUNT_A, COMPANY_X, '2026-07-22T10:00:00Z'));
    const seen = await asApp(scope(ACCOUNT_A, COMPANY_X), (k) => k.selectFrom('activity_events').select('event_id').execute());
    expect(seen.map((r) => r.event_id)).toEqual([U1]);
    // Same account, different company → hidden.
    expect(await asApp(scope(ACCOUNT_A, COMPANY_Y), (k) => k.selectFrom('activity_events').selectAll().execute())).toHaveLength(0);
    // Different account, same company id → hidden.
    expect(await asApp(scope(ACCOUNT_B, COMPANY_X), (k) => k.selectFrom('activity_events').selectAll().execute())).toHaveLength(0);
  });

  test('forged/absent context is rejected on insert (fail-closed dual WITH CHECK)', async () => {
    // account/company mismatch vs the claimed row.
    await expect(asApp(scope(ACCOUNT_A, COMPANY_X), (k) => insertActivity(k, U2, ACCOUNT_B, COMPANY_X, '2026-07-22T10:00:00Z'))).rejects.toThrow();
    await expect(asApp(scope(ACCOUNT_A, COMPANY_X), (k) => insertActivity(k, U2, ACCOUNT_A, COMPANY_Y, '2026-07-22T10:00:00Z'))).rejects.toThrow();
    // No company context → rejected; no context at all → rejected.
    await expect(asApp({ 'app.current_account': ACCOUNT_A }, (k) => insertActivity(k, U2, ACCOUNT_A, COMPANY_X, '2026-07-22T10:00:00Z'))).rejects.toThrow();
    await expect(asApp({}, (k) => insertActivity(k, U2, ACCOUNT_A, COMPANY_X, '2026-07-22T10:00:00Z'))).rejects.toThrow();
  });

  test('fail-closed read: empty/malformed context reveals nothing with no cast error', async () => {
    await asApp(scope(ACCOUNT_A, COMPANY_X), (k) => insertActivity(k, U1, ACCOUNT_A, COMPANY_X, '2026-07-22T10:00:00Z'));
    for (const ctx of [{}, { 'app.current_account': ACCOUNT_A, 'app.current_company': '' }, { 'app.current_account': ACCOUNT_A, 'app.current_company': 'not-a-uuid' }]) {
      const n = await asApp(ctx, (k) => sql<{ n: number }>`select count(*)::int as n from activity_events`.execute(k).then((x) => x.rows[0]?.n));
      expect(n).toBe(0);
    }
  });

  test('append-only: UPDATE, DELETE, TRUNCATE are all denied to the restricted role', async () => {
    await asApp(scope(ACCOUNT_A, COMPANY_X), (k) => insertActivity(k, U1, ACCOUNT_A, COMPANY_X, '2026-07-22T10:00:00Z'));
    await expect(asApp(scope(ACCOUNT_A, COMPANY_X), (k) => sql`update activity_events set activity_type = 'company.paused'`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(ACCOUNT_A, COMPANY_X), (k) => sql`delete from activity_events`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(ACCOUNT_A, COMPANY_X), (k) => sql`truncate activity_events`.execute(k))).rejects.toThrow();
    expect(await asApp(scope(ACCOUNT_A, COMPANY_X), (k) => k.selectFrom('activity_events').selectAll().execute())).toHaveLength(1);
  });

  test('idempotent by event_id: a duplicate source event id is rejected (no duplicate feed item)', async () => {
    await asApp(scope(ACCOUNT_A, COMPANY_X), (k) => insertActivity(k, U1, ACCOUNT_A, COMPANY_X, '2026-07-22T10:00:00Z'));
    await expect(asApp(scope(ACCOUNT_A, COMPANY_X), (k) => insertActivity(k, U1, ACCOUNT_A, COMPANY_X, '2026-07-22T11:00:00Z'))).rejects.toThrow();
  });

  test('type CHECK: only the four company activity types are accepted', async () => {
    await expect(asApp(scope(ACCOUNT_A, COMPANY_X), (k) => insertActivity(k, U2, ACCOUNT_A, COMPANY_X, '2026-07-22T10:00:00Z', 'membership.invited'))).rejects.toThrow();
    for (const t of ['company.created', 'company.updated', 'company.paused', 'company.resumed'] as const) {
      await su.kysely.deleteFrom('activity_events').execute();
      await asApp(scope(ACCOUNT_A, COMPANY_X), (k) => insertActivity(k, U2, ACCOUNT_A, COMPANY_X, '2026-07-22T10:00:00Z', t));
    }
  });

  test('keyset ordering: occurred_at DESC, event_id DESC', async () => {
    await asApp(scope(ACCOUNT_A, COMPANY_X), async (k) => {
      await insertActivity(k, U1, ACCOUNT_A, COMPANY_X, '2026-07-22T10:00:00Z');
      await insertActivity(k, U2, ACCOUNT_A, COMPANY_X, '2026-07-22T12:00:00Z');
      await insertActivity(k, U3, ACCOUNT_A, COMPANY_X, '2026-07-22T11:00:00Z');
    });
    const rows = await asApp(scope(ACCOUNT_A, COMPANY_X), (k) => k.selectFrom('activity_events').select('event_id').orderBy('occurred_at', 'desc').orderBy('event_id', 'desc').execute());
    expect(rows.map((r) => r.event_id)).toEqual([U2, U3, U1]);
  });

  test('query plan: the keyset feed query can use activity_events_feed_idx (no seq scan) on seeded volume', async () => {
    // Seed 300 rows for company X via the superuser (BYPASSRLS) — realistic enough for the planner.
    await sql`
      insert into activity_events (event_id, account_id, company_id, activity_type, schema_version, occurred_at, actor_type, actor_id, subject_type, subject_id, payload)
      select
        lpad(upper(to_hex(g)), 26, '0'),
        ${ACCOUNT_A}::uuid, ${COMPANY_X}::uuid, 'company.updated', 1,
        timestamptz '2026-07-01' + (g || ' seconds')::interval,
        'user', ${ACTOR_U}::uuid, 'company', ${COMPANY_X}, '{}'::jsonb
      from generate_series(1, 300) g
    `.execute(su.kysely);
    // As the restricted role under CompanyScope, EXPLAIN the exact keyset shape with seqscan disabled to prove
    // the intended index is USABLE (small tables may otherwise prefer a seq scan; usability is the claim).
    const plan = await asApp(scope(ACCOUNT_A, COMPANY_X), async (k) => {
      await sql`set local enable_seqscan = off`.execute(k);
      const r = await sql<{ 'QUERY PLAN': string }>`
        explain select * from activity_events
        where company_id = ${COMPANY_X}::uuid
          and (occurred_at < now() or (occurred_at = now() and event_id <= 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ'))
        order by occurred_at desc, event_id desc
        limit 26
      `.execute(k);
      return r.rows.map((x) => x['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('activity_events_feed_idx');
    expect(plan).not.toContain('Seq Scan on activity_events');
    expect(plan).toContain('Limit'); // bounded result
  });

  test('historical backfill (0009): eligible audit company events project exactly once, redacted, ids/times preserved', async () => {
    // Rebuild the schema stepwise: through 0008, seed audit history, then apply 0009 (which backfills).
    for (const t of ['activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const upTo = await createMigrator(su).migrateTo('0008_companies');
    expect(upTo.error).toBeUndefined();

    // Eligible: two company events (one with a MICROSECOND-precision occurred_at + a junk payload key to prove
    // truncation + redaction). Ineligible: an account-level membership event (company_id NULL) and an
    // unknown/undeclared company event name (excluded by the taxonomy predicate).
    await sql`
      insert into audit_events (event_id, name, schema_version, account_id, company_id, actor_type, actor_id, subject_type, subject_id, outcome, payload, occurred_at, correlation_id) values
      (${U1}, 'company.created', 1, ${ACCOUNT_A}::uuid, ${COMPANY_X}::uuid, 'user', ${ACTOR_U}::uuid, 'company', ${COMPANY_X}, 'success', '{"creation_mode":"own_idea","junk":"drop-me"}'::jsonb, timestamptz '2026-07-10 10:00:00.123456+00', 'corr-1'),
      (${U2}, 'company.paused', 1, ${ACCOUNT_A}::uuid, ${COMPANY_X}::uuid, 'user', ${ACTOR_U}::uuid, 'company', ${COMPANY_X}, 'success', '{"reason":"should-not-copy"}'::jsonb, timestamptz '2026-07-11 11:00:00+00', null),
      (${U3}, 'membership.invited', 1, ${ACCOUNT_A}::uuid, null, 'user', ${ACTOR_U}::uuid, 'membership', 'm_1', 'success', '{"role":"viewer"}'::jsonb, timestamptz '2026-07-12 12:00:00+00', null),
      ('01ARZ3NDEKTSV4RRFFQ69G5FB9', 'company.deleted', 1, ${ACCOUNT_A}::uuid, ${COMPANY_X}::uuid, 'user', ${ACTOR_U}::uuid, 'company', ${COMPANY_X}, 'success', '{}'::jsonb, timestamptz '2026-07-13 13:00:00+00', null)
    `.execute(su.kysely);

    const rest = await migrateToLatest(su);
    expect(rest.error).toBeUndefined();

    // Only the two ELIGIBLE rows projected; ids preserved; redaction exact; occurred_at on the millisecond grid.
    const rows = await su.kysely.selectFrom('activity_events').selectAll().orderBy('event_id', 'asc').execute();
    expect(rows.map((r) => r.event_id).sort()).toEqual([U1, U2].sort());
    const created = rows.find((r) => r.event_id === U1);
    expect(created).toMatchObject({ account_id: ACCOUNT_A, company_id: COMPANY_X, activity_type: 'company.created', actor_type: 'user', actor_id: ACTOR_U, subject_id: COMPANY_X, schema_version: 1 });
    expect(created?.payload).toEqual({ creation_mode: 'own_idea' }); // junk + correlation NEVER copied
    expect(new Date(created?.occurred_at ?? 0).toISOString()).toBe('2026-07-10T10:00:00.123Z'); // date_trunc millis
    const paused = rows.find((r) => r.event_id === U2);
    expect(paused?.payload).toEqual({}); // paused summary is empty — 'reason' never copied

    // Rerunning the SAME backfill statement is idempotent (ON CONFLICT DO NOTHING → no duplicates).
    await sql`
      insert into public.activity_events
        (event_id, account_id, company_id, activity_type, schema_version, occurred_at, actor_type, actor_id, subject_type, subject_id, payload)
      select ae.event_id, ae.account_id, ae.company_id, ae.name, ae.schema_version, date_trunc('milliseconds', ae.occurred_at), ae.actor_type, ae.actor_id, ae.subject_type, ae.subject_id,
        case ae.name
          when 'company.created' then jsonb_strip_nulls(jsonb_build_object('creation_mode', ae.payload->'creation_mode'))
          when 'company.updated' then jsonb_strip_nulls(jsonb_build_object('changed_fields', ae.payload->'changed_fields'))
          else '{}'::jsonb
        end
      from public.audit_events ae
      where ae.company_id is not null and ae.name in ('company.created', 'company.updated', 'company.paused', 'company.resumed')
      on conflict (event_id) do nothing
    `.execute(su.kysely);
    expect((await su.kysely.selectFrom('activity_events').selectAll().execute())).toHaveLength(2);

    // Down/up reapply of 0009 is deterministic: same two rows, same redaction.
    const down = await createMigrator(su).migrateDown();
    expect(down.error).toBeUndefined();
    const reup = await migrateToLatest(su);
    expect(reup.error).toBeUndefined();
    const again = await su.kysely.selectFrom('activity_events').selectAll().execute();
    expect(again.map((r) => r.event_id).sort()).toEqual([U1, U2].sort());
  });

  test('catalog: FORCE RLS; acbp_app has INSERT+SELECT only; allowlist still 3 SECURITY DEFINER', async () => {
    const rel = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'activity_events'`.execute(su.kysely);
    expect(rel.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const grants = await sql<{ privilege_type: string }>`select privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'activity_events'`.execute(su.kysely);
    expect(grants.rows.map((r) => r.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
    const cmds = await sql<{ cmd: string }>`select cmd from pg_policies where tablename = 'activity_events'`.execute(su.kysely);
    expect(cmds.rows.map((r) => r.cmd).sort()).toEqual(['INSERT', 'SELECT']);
    const definers = await sql<{ n: number }>`select count(*)::int as n from pg_proc where prosecdef = true and proname like 'acbp_%'`.execute(su.kysely);
    expect(definers.rows[0]?.n).toBe(3);
  });
});
