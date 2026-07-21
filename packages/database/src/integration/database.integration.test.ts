// ACBP-P0-018 — real-PostgreSQL integration suite (no mocks). Skips when ACBP_TEST_DATABASE_URL is
// unset. Covers: health, migrations (apply/re-run/history/failure-stops/concurrency), transaction
// commit/rollback + connection release, RLS-ready tenant session settings, and the no-domain-tables
// guarantee. Uses a disposable database and cleans up its own artifacts afterward.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { Migrator, sql } from 'kysely';
import type { Kysely, MigrationProvider } from 'kysely';
import { checkDatabaseHealth, closeDatabase, migrateToLatest, migrateDown, migrationStatus, withTransaction, withTenantTransaction, type DatabaseClient } from '../index.js';
import { createTestDatabase, hasTestDatabase } from './harness.js';

async function drop(client: DatabaseClient, table: string): Promise<void> {
  await sql.raw(`drop table if exists ${table} cascade`).execute(client.kysely);
}

async function cleanup(client: DatabaseClient): Promise<void> {
  // identity_webhook_receipts + users are the ACBP-P1-002 tables (migration 0002); dropped here so
  // this foundation suite starts from a clean slate regardless of applied domain migrations.
  for (const t of ['audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', '_it_a', '_it_c', '_t_rollback', 'kysely_migration', 'kysely_migration_lock', '_it_migration', '_it_migration_lock']) {
    await drop(client, t);
  }
}

describe.skipIf(!hasTestDatabase)('database integration (real PostgreSQL)', () => {
  let client: DatabaseClient;

  beforeAll(async () => {
    client = createTestDatabase();
    await cleanup(client); // start from a clean slate
  });

  afterAll(async () => {
    if (client) {
      await cleanup(client);
      await closeDatabase(client);
    }
  });

  test('health check succeeds against a real PostgreSQL server', async () => {
    const health = await checkDatabaseHealth(client);
    expect(health.ok).toBe(true);
    const { rows } = await sql<{ version: string }>`select version() as version`.execute(client.kysely);
    expect(rows[0]?.version).toContain('PostgreSQL');
  });

  test('migrations apply to a clean database and re-running is a no-op', async () => {
    const first = await migrateToLatest(client);
    expect(first.error).toBeUndefined();
    expect(first.results?.some((r) => r.migrationName.includes('platform_init') && r.status === 'Success')).toBe(true);
    // The probe table now exists.
    const probe = await sql<{ n: number }>`select count(*)::int as n from _acbp_migration_probe`.execute(client.kysely);
    expect(probe.rows[0]?.n).toBe(0);
    // Re-run applies nothing new.
    const second = await migrateToLatest(client);
    expect(second.error).toBeUndefined();
    expect(second.results?.length ?? 0).toBe(0);
  });

  test('migration history is recorded and queryable', async () => {
    const status = await migrationStatus(client);
    expect(status.some((m) => m.name.includes('platform_init') && m.executedAt !== undefined)).toBe(true);
  });

  test('migrations reverse fully and re-apply restores every managed table', async () => {
    await migrateToLatest(client); // ensure applied (idempotent)
    // Reverse each applied migration batch until none remain (robust to any number of migrations).
    for (let i = 0; i < 50; i++) {
      const down = await migrateDown(client);
      expect(down.error).toBeUndefined();
      if ((down.results?.length ?? 0) === 0) break;
    }
    const afterDown = await sql<{ n: number }>`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name in ('_acbp_migration_probe', 'users', 'identity_webhook_receipts')`.execute(client.kysely);
    expect(afterDown.rows[0]?.n).toBe(0); // every migration-managed table dropped by down()
    const reapply = await migrateToLatest(client);
    expect(reapply.error).toBeUndefined();
    const afterUp = await sql<{ n: number }>`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name in ('_acbp_migration_probe', 'users', 'identity_webhook_receipts')`.execute(client.kysely);
    expect(afterUp.rows[0]?.n).toBe(3); // probe (0001) + users + receipts (0002) restored by re-apply
  });

  test('a deliberately failing migration stops progression with no partial apply', async () => {
    const provider: MigrationProvider = {
      getMigrations: () =>
        Promise.resolve({
          '9001_ok': {
            up: async (db: Kysely<unknown>) => {
              await sql`create table _it_a (id integer primary key)`.execute(db);
            },
          },
          '9002_bad': {
            up: () => Promise.reject(new Error('intentional migration failure')),
          },
          '9003_after': {
            up: async (db: Kysely<unknown>) => {
              await sql`create table _it_c (id integer primary key)`.execute(db);
            },
          },
        }),
    };
    // Isolated migration/lock tables so this failure experiment is independent of the real history.
    const migrator = new Migrator({ db: client.kysely, provider, migrationTableName: '_it_migration', migrationLockTableName: '_it_migration_lock' });
    const res = await migrator.migrateToLatest();
    expect(res.error).toBeDefined(); // the batch failed at 9002_bad
    // PostgreSQL has transactional DDL, so Kysely runs the batch in a transaction: a failure rolls
    // back the ENTIRE batch — no partial apply (BACKLOG.csv: "Migration failure = no partial apply").
    const tables = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema = 'public'`.execute(client.kysely);
    const names = tables.rows.map((r) => r.table_name);
    expect(names).not.toContain('_it_a'); // pre-failure migration rolled back with the batch
    expect(names).not.toContain('_it_c'); // post-failure migration never ran
  });

  test('concurrent migration runs are serialized (no double-apply / no error)', async () => {
    const [a, b] = await Promise.all([migrateToLatest(client), migrateToLatest(client)]);
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
  });

  test('transaction commits on success and releases the connection', async () => {
    await withTransaction(client, async (tx) => {
      await sql`create table _t_rollback (id integer primary key)`.execute(tx.kysely);
      await sql`insert into _t_rollback (id) values (1)`.execute(tx.kysely);
    });
    const after = await sql<{ n: number }>`select count(*)::int as n from _t_rollback`.execute(client.kysely);
    expect(after.rows[0]?.n).toBe(1);
    // Pool still healthy => the connection was released back to it.
    expect((await checkDatabaseHealth(client)).ok).toBe(true);
  });

  test('transaction rolls back on failure and releases the connection', async () => {
    await drop(client, '_t_rollback');
    await expect(
      withTransaction(client, async (tx) => {
        await sql`create table _t_rollback (id integer primary key)`.execute(tx.kysely);
        throw new Error('boom');
      }),
    ).rejects.toBeDefined();
    const tables = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema = 'public' and table_name = '_t_rollback'`.execute(client.kysely);
    expect(tables.rows.length).toBe(0); // rolled back
    expect((await checkDatabaseHealth(client)).ok).toBe(true); // connection released
  });

  test('withTenantTransaction applies RLS-ready tenant session settings', async () => {
    const seen = await withTenantTransaction(client, { accountId: 'acc_1', companyId: 'co_9', actorId: 'usr_1' }, async (scope) => {
      const r = await sql<{ company: string | null }>`select current_setting('app.current_company', true) as company`.execute(scope.db);
      return r.rows[0]?.company ?? null;
    });
    expect(seen).toBe('co_9');
  });

  test('only the P1-002..P1-008 domain tables exist; later-ticket tables do not', async () => {
    await migrateToLatest(client); // ensure applied (a prior test may have reversed then re-applied)
    const r = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema = 'public'`.execute(client.kysely);
    const names = r.rows.map((x) => x.table_name);
    // P1-002 (identity) + P1-003 (account root + profile) + P1-004 (memberships) + P1-008 (audit) domain tables.
    expect(names).toContain('users');
    expect(names).toContain('identity_webhook_receipts');
    expect(names).toContain('accounts');
    expect(names).toContain('account_profiles');
    expect(names).toContain('memberships');
    expect(names).toContain('audit_events');
    // Company/tasks/approvals/usage and other later-ticket tables must NOT exist yet.
    for (const notYet of ['companies', 'tasks', 'task_runs', 'approvals', 'usage_events', 'policies']) {
      expect(names).not.toContain(notYet);
    }
  });
});
