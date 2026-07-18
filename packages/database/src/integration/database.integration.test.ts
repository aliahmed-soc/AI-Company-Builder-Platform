// ACBP-P0-018 — real-PostgreSQL integration suite (no mocks). Skips when ACBP_TEST_DATABASE_URL is
// unset. Covers: health, migrations (apply/re-run/history/failure-stops/concurrency), transaction
// commit/rollback + connection release, RLS-ready tenant session settings, and the no-domain-tables
// guarantee. Uses a disposable database and cleans up its own artifacts afterward.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { Migrator, sql } from 'kysely';
import type { Kysely, MigrationProvider } from 'kysely';
import { checkDatabaseHealth, closeDatabase, migrateToLatest, migrationStatus, withTransaction, withTenantTransaction, type DatabaseClient } from '../index.js';
import { createTestDatabase, hasTestDatabase } from './harness.js';

async function drop(client: DatabaseClient, table: string): Promise<void> {
  await sql.raw(`drop table if exists ${table} cascade`).execute(client.kysely);
}

async function cleanup(client: DatabaseClient): Promise<void> {
  for (const t of ['_acbp_migration_probe', '_it_a', '_it_c', '_t_rollback', 'kysely_migration', 'kysely_migration_lock']) {
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

  test('a deliberately failing migration stops progression (no partial apply past it)', async () => {
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
    const migrator = new Migrator({ db: client.kysely, provider });
    const res = await migrator.migrateToLatest();
    expect(res.error).toBeDefined();
    const tables = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema = 'public'`.execute(client.kysely);
    const names = tables.rows.map((r) => r.table_name);
    expect(names).toContain('_it_a'); // migration before the failure applied
    expect(names).not.toContain('_it_c'); // migration after the failure did NOT apply
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

  test('no product-domain tables were introduced by the foundation', async () => {
    const r = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema = 'public'`.execute(client.kysely);
    const names = r.rows.map((x) => x.table_name);
    for (const domain of ['accounts', 'users', 'companies', 'memberships', 'tasks', 'task_runs', 'approvals', 'usage_events', 'audit_events', 'policies']) {
      expect(names).not.toContain(domain);
    }
  });
});
