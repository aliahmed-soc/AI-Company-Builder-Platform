// ACBP-P1-005 / CDR-012 — real-PostgreSQL integration for the account-level tenancy primitive. Skips when
// ACBP_TEST_DATABASE_URL is unset (hosted CI runs it zero-skip). Proves the SET LOCAL semantics of
// withAccountTransaction: it sets app.current_account + app.current_actor, NEVER app.current_company, the
// settings are transaction-local (revert on commit/rollback), and they do not leak across transactions.
// Creates no tables (custom GUCs need none), so it is order-independent on the shared serial DB.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { withAccountTransaction, closeDatabase, type DatabaseClient } from '../index.js';
import { createTestDatabase, hasTestDatabase } from './harness.js';

async function currentAccount(exec: DatabaseClient['kysely']): Promise<string | null> {
  const r = await sql<{ a: string | null }>`select current_setting('app.current_account', true) as a`.execute(exec);
  return r.rows[0]?.a ?? null;
}

const isEmpty = (v: string | null): boolean => v === null || v === '';

describe.skipIf(!hasTestDatabase)('account tenancy GUCs (real PostgreSQL) — ACBP-P1-005/CDR-012', () => {
  let client: DatabaseClient;

  beforeAll(() => {
    client = createTestDatabase();
  });

  afterAll(async () => {
    if (client) await closeDatabase(client);
  });

  test('withAccountTransaction sets app.current_account + app.current_actor via SET LOCAL', async () => {
    const seen = await withAccountTransaction(client, { accountId: 'acc_A', actorId: 'usr_A' }, async (scope) => {
      const r = await sql<{ account: string | null; actor: string | null }>`select current_setting('app.current_account', true) as account, current_setting('app.current_actor', true) as actor`.execute(scope.db);
      return r.rows[0];
    });
    expect(seen?.account).toBe('acc_A');
    expect(seen?.actor).toBe('usr_A');
  });

  test('withAccountTransaction NEVER sets app.current_company (CDR-012 #5 — no fabricated company)', async () => {
    const company = await withAccountTransaction(client, { accountId: 'acc_B', actorId: 'usr_B' }, async (scope) => {
      const r = await sql<{ company: string | null }>`select current_setting('app.current_company', true) as company`.execute(scope.db);
      return r.rows[0]?.company ?? null;
    });
    // Company-owned RLS (P1-006) fails closed when this is empty; account scope must never fabricate it.
    expect(isEmpty(company)).toBe(true);
  });

  test('actor GUC defaults to empty string when actorId is absent', async () => {
    const actor = await withAccountTransaction(client, { accountId: 'acc_C' }, async (scope) => {
      const r = await sql<{ actor: string | null }>`select current_setting('app.current_actor', true) as actor`.execute(scope.db);
      return r.rows[0]?.actor ?? null;
    });
    expect(actor).toBe('');
  });

  test('account GUC is transaction-local — it does not persist after the transaction', async () => {
    await withAccountTransaction(client, { accountId: 'acc_D', actorId: 'usr_D' }, async (scope) => {
      expect(await currentAccount(scope.db)).toBe('acc_D');
    });
    // A fresh query on the pool must NOT still see acc_D (SET LOCAL reverted on commit).
    expect(isEmpty(await currentAccount(client.kysely))).toBe(true);
  });

  test('GUC values do not leak between successive account transactions', async () => {
    const first = await withAccountTransaction(client, { accountId: 'acc_first', actorId: 'usr_1' }, (scope) => currentAccount(scope.db));
    const second = await withAccountTransaction(client, { accountId: 'acc_second', actorId: 'usr_2' }, (scope) => currentAccount(scope.db));
    expect(first).toBe('acc_first');
    expect(second).toBe('acc_second');
  });

  test('a rolled-back account transaction leaves no residual account GUC', async () => {
    await expect(
      withAccountTransaction(client, { accountId: 'acc_rb', actorId: 'usr_rb' }, async (scope) => {
        expect(await currentAccount(scope.db)).toBe('acc_rb');
        throw new Error('boom');
      }),
    ).rejects.toBeDefined();
    expect(isEmpty(await currentAccount(client.kysely))).toBe(true);
  });

  test('concurrent account transactions each see only their own account (no cross-connection bleed)', async () => {
    const [a, b] = await Promise.all([
      withAccountTransaction(client, { accountId: 'acc_conc_1', actorId: 'u1' }, (scope) => currentAccount(scope.db)),
      withAccountTransaction(client, { accountId: 'acc_conc_2', actorId: 'u2' }, (scope) => currentAccount(scope.db)),
    ]);
    expect(a).toBe('acc_conc_1');
    expect(b).toBe('acc_conc_2');
  });
});
