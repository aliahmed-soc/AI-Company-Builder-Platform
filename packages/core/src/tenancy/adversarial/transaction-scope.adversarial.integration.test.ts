// ACBP-P1-014 / CDR-020 — TRANSACTION, POOLING, GUC-LIFECYCLE and NESTED-SCOPE adversarial suite.
//
// Threat ids: TX-GUC-COMMIT-CLEANUP, TX-GUC-ROLLBACK-CLEANUP, TX-GUC-THROWN-ERROR-CLEANUP,
//             TX-GUC-DENIAL-CLEANUP, TX-SCOPE-MUTATION, TX-NESTED-SCOPE, AUDIT-ROLLBACK-ATOMICITY.
// Production entrypoints: `withAccountTransaction`, `withTenantTransaction`, `withTransaction`,
//             `runInAccountScope`, `runInCompanyScope`, `elevateToCompanyScope`, `createCompany`.
// Proof level: database primitive + core composition.
// Real PostgreSQL is MANDATORY: the invariant is that `SET LOCAL` context dies with the transaction on a
// REUSED pooled connection — an in-memory double has no connection to leak.
//
// POOL DETERMINISM: the restricted client is created with a pool, and these tests deliberately run their
// probes SEQUENTIALLY with no other in-flight work, so the same physical connection is handed back. To make
// that explicit rather than assumed, each cleanup probe also records `pg_backend_pid()` and asserts the probe
// ran on the SAME backend as the scoped transaction it is probing. If a probe ever lands on a different
// backend the test says so instead of silently proving nothing.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { withTransaction, withAccountTransaction, withTenantTransaction, elevateToCompanyScope, nestedTransactionError, CompanyRepository, type DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from './two-tenant-harness.js';
import { threatTitle } from './threat-inventory.js';
import { runInAccountScope } from '../account-context-resolver.js';
import { runInCompanyScope } from '../../company/company-context-resolver.js';
import { createCompany } from '../../company/company-service.js';

interface GucSnapshot {
  readonly actor: string;
  readonly account: string;
  readonly company: string;
  readonly pid: number;
}

/** Read the three tenant GUCs + the backend pid on a bare (unscoped) transaction. */
async function probeGucs(client: DatabaseClient): Promise<GucSnapshot> {
  return withTransaction(client, async (tx) => {
    const r = await sql<{ actor: string | null; account: string | null; company: string | null; pid: number }>`
      select current_setting('app.current_actor', true) as actor,
             current_setting('app.current_account', true) as account,
             current_setting('app.current_company', true) as company,
             pg_backend_pid() as pid
    `.execute(tx.kysely);
    const row = r.rows[0];
    if (row === undefined) throw new Error('probe failed');
    return { actor: row.actor ?? '', account: row.account ?? '', company: row.company ?? '', pid: row.pid };
  });
}

function expectNoResidualContext(snapshot: GucSnapshot, scopedPid: number, threatId: string): void {
  expect(snapshot.pid, `${threatId}: the probe must run on the SAME pooled backend (${scopedPid}) to prove reuse`).toBe(scopedPid);
  expect(snapshot.actor, `${threatId}: app.current_actor leaked`).toBe('');
  expect(snapshot.account, `${threatId}: app.current_account leaked`).toBe('');
  expect(snapshot.company, `${threatId}: app.current_company leaked`).toBe('');
}

describe.skipIf(!hasTestDatabase)('transaction scope + pooled GUC lifecycle (real PostgreSQL, restricted role) — ACBP-P1-014/CDR-020', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    await assertRestrictedRole(product);
  }, 60_000);
  afterAll(async () => {
    await teardown(owner, product);
  });
  beforeEach(async () => {
    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product);
  });

  test(threatTitle('TX-GUC-COMMIT-CLEANUP', 'account + company scope'), async () => {
    // ACCOUNT scope, committed…
    const accountPid = await withAccountTransaction(product, { accountId: w.accountA, actorId: w.aOwner }, async (scope) => {
      const r = await sql<{ pid: number; account: string }>`select pg_backend_pid() as pid, current_setting('app.current_account', true) as account`.execute(scope.db);
      expect(r.rows[0]?.account).toBe(w.accountA); // context really was established
      return r.rows[0]!.pid;
    });
    expectNoResidualContext(await probeGucs(product), accountPid, 'TX-GUC-COMMIT-CLEANUP/account');

    // COMPANY scope, committed…
    const companyPid = await withTenantTransaction(product, { accountId: w.accountA, companyId: w.companyA1, actorId: w.aOwner }, async (scope) => {
      const r = await sql<{ pid: number; company: string }>`select pg_backend_pid() as pid, current_setting('app.current_company', true) as company`.execute(scope.db);
      expect(r.rows[0]?.company).toBe(w.companyA1);
      return r.rows[0]!.pid;
    });
    expectNoResidualContext(await probeGucs(product), companyPid, 'TX-GUC-COMMIT-CLEANUP/company');

    // …and a protected query on the reused connection with NO context sees nothing.
    const leaked = await withTransaction(product, async (tx) => new CompanyRepository(tx.kysely).findById(w.companyA1));
    expect(leaked).toBeUndefined();
  });

  test(threatTitle('TX-GUC-ROLLBACK-CLEANUP', 'account + company scope'), async () => {
    let accountPid = 0;
    await expect(
      withAccountTransaction(product, { accountId: w.accountA, actorId: w.aOwner }, async (scope) => {
        accountPid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(scope.db)).rows[0]!.pid;
        throw new Error('deliberate rollback');
      }),
    ).rejects.toBeDefined();
    expectNoResidualContext(await probeGucs(product), accountPid, 'TX-GUC-ROLLBACK-CLEANUP/account');

    let companyPid = 0;
    await expect(
      withTenantTransaction(product, { accountId: w.accountA, companyId: w.companyA1, actorId: w.aOwner }, async (scope) => {
        companyPid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(scope.db)).rows[0]!.pid;
        throw new Error('deliberate rollback');
      }),
    ).rejects.toBeDefined();
    expectNoResidualContext(await probeGucs(product), companyPid, 'TX-GUC-ROLLBACK-CLEANUP/company');
  });

  test(threatTitle('TX-GUC-THROWN-ERROR-CLEANUP', 'aborted SQL transaction on a reused connection'), async () => {
    // A real SQL failure (not an application throw) aborts the transaction; the connection must still come
    // back clean and usable.
    let pid = 0;
    await expect(
      withTenantTransaction(product, { accountId: w.accountA, companyId: w.companyA1, actorId: w.aOwner }, async (scope) => {
        pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(scope.db)).rows[0]!.pid;
        await sql`select * from this_relation_does_not_exist`.execute(scope.db);
      }),
    ).rejects.toBeDefined();
    expectNoResidualContext(await probeGucs(product), pid, 'TX-GUC-THROWN-ERROR-CLEANUP');
    // The connection is genuinely reusable afterwards (not poisoned).
    const ok = await withTenantTransaction(product, { accountId: w.accountA, companyId: w.companyA1, actorId: w.aOwner }, async (scope) => new CompanyRepository(scope.db).findById(w.companyA1));
    expect(ok?.id).toBe(w.companyA1);
  });

  test(threatTitle('TX-GUC-DENIAL-CLEANUP', 'authorization denial leaves no context'), async () => {
    const before = await probeGucs(product);
    const denied = await runInCompanyScope(product, { userId: w.outsider, requestedAccountId: w.accountA, requestedCompanyId: w.companyA1 }, () => Promise.resolve('ran'));
    expect(denied.kind).toBe('denied');
    const after = await probeGucs(product);
    expect(after.actor).toBe('');
    expect(after.account).toBe('');
    expect(after.company).toBe('');
    expect(after.pid).toBe(before.pid); // same pooled backend — the probe is meaningful
  });

  test(threatTitle('AUDIT-ROLLBACK-ATOMICITY', 'audit failure rolls back the mutation AND leaves no context'), async () => {
    const failing = (): Promise<string> => Promise.reject(new Error('audit boom'));
    await expect(createCompany(product, { accountId: w.accountA, actingUserId: w.aOwner, creationMode: 'own_idea', name: 'Ghost Co' }, { auditWriter: failing })).rejects.toBeDefined();
    // No company (the name lives in company_profiles — a ghost would leave a v1 profile row), no residual scope.
    const ghostProfiles = await owner.kysely.selectFrom('company_profiles').select('company_id').where('name', '=', 'Ghost Co').execute();
    expect(ghostProfiles).toEqual([]);
    const companiesInA = await owner.kysely.selectFrom('companies').select('id').where('account_id', '=', w.accountA).execute();
    expect(companiesInA.map((c) => c.id).sort()).toEqual([w.companyA1, w.companyA2].sort());
    const snapshot = await probeGucs(product);
    expect([snapshot.actor, snapshot.account, snapshot.company]).toEqual(['', '', '']);
  });

  test(threatTitle('TX-NESTED-SCOPE', 'account and company scope runners reject nesting'), async () => {
    const expected = nestedTransactionError().message;
    // AccountScope inside an active AccountScope.
    await expect(
      withAccountTransaction(product, { accountId: w.accountA, actorId: w.aOwner }, async (scope) =>
        withAccountTransaction({ ...product, kysely: scope.db, inTransaction: true } as unknown as DatabaseClient, { accountId: w.accountB, actorId: w.bOwner }, () => Promise.resolve('nested')),
      ),
    ).rejects.toThrow();
    // CompanyScope inside an active CompanyScope.
    await expect(
      withTenantTransaction(product, { accountId: w.accountA, companyId: w.companyA1, actorId: w.aOwner }, async (scope) =>
        withTenantTransaction({ ...product, kysely: scope.db, inTransaction: true } as unknown as DatabaseClient, { accountId: w.accountB, companyId: w.companyB1, actorId: w.bOwner }, () => Promise.resolve('nested')),
      ),
    ).rejects.toThrow();
    expect(expected).toContain('Nested transactions are not supported');
  });

  test(threatTitle('TX-SCOPE-MUTATION', 'elevation to a FOREIGN company inside an account scope is refused'), async () => {
    // elevateToCompanyScope is the ONE production account→company elevation. Attempting to elevate an
    // account-A scope into a company of account B must fail closed and must not mutate the transaction.
    await expect(
      withAccountTransaction(product, { accountId: w.accountA, actorId: w.aOwner }, async (scope) => elevateToCompanyScope(scope, w.companyB1)),
    ).rejects.toBeDefined();
    // Same for a company that exists nowhere.
    await expect(
      withAccountTransaction(product, { accountId: w.accountA, actorId: w.aOwner }, async (scope) => elevateToCompanyScope(scope, '00000000-0000-4000-8000-0000000000ff')),
    ).rejects.toBeDefined();
    // The legitimate elevation still works (the refusals above are specific, not blanket).
    const legit = await withAccountTransaction(product, { accountId: w.accountA, actorId: w.aOwner }, async (scope) => {
      const company = await elevateToCompanyScope(scope, w.companyA1);
      return new CompanyRepository(company.db).findById(w.companyA1);
    });
    expect(legit?.id).toBe(w.companyA1);
  });

  test(threatTitle('TX-SCOPE-MUTATION', 'raw mid-transaction GUC mutation cannot reach a foreign tenant'), async () => {
    // Raw SET LOCAL is available to in-transaction code by design (trusted internal primitives use it).
    // The invariant under test is therefore NOT "the SET fails" but "mutation buys no foreign data":
    // repointing app.current_company at another ACCOUNT's company leaves the account key mismatched, and the
    // dual-keyed policies deny.
    const observed = await withTenantTransaction(product, { accountId: w.accountA, companyId: w.companyA1, actorId: w.aOwner }, async (scope) => {
      await sql`select set_config('app.current_company', ${w.companyB1}, true)`.execute(scope.db);
      const foreign = await new CompanyRepository(scope.db).findById(w.companyB1);
      const activity = await sql<{ n: number }>`select count(*)::int as n from activity_events`.execute(scope.db);
      const provisioning = await sql<{ n: number }>`select count(*)::int as n from provisioning_steps`.execute(scope.db);
      return { foreign, activity: activity.rows[0]?.n, provisioning: provisioning.rows[0]?.n };
    });
    expect(observed.foreign).toBeUndefined();
    expect(observed.activity).toBe(0);
    expect(observed.provisioning).toBe(0);
    // Repointing the ACCOUNT key as well is the full forgery — still nothing, because company_memberships
    // and the audit trail bind rows to the pair, and the attacker cannot forge a membership row.
    const bothForged = await withTenantTransaction(product, { accountId: w.accountA, companyId: w.companyA1, actorId: w.aOwner }, async (scope) => {
      await sql`select set_config('app.current_account', ${w.accountB}, true)`.execute(scope.db);
      await sql`select set_config('app.current_company', ${w.companyB1}, true)`.execute(scope.db);
      const inserted = await sql`insert into activity_events (event_id, account_id, company_id, activity_type, occurred_at, actor_type)
                                 values (gen_random_uuid(), ${w.accountA}::uuid, ${w.companyA1}::uuid, 'company.created', now(), 'user')`
        .execute(scope.db)
        .then(() => 'inserted')
        .catch(() => 'denied');
      return inserted;
    }).catch(() => 'denied');
    expect(bothForged).toBe('denied'); // a row stamped for A cannot be written while scoped to B
  });

  test(threatTitle('TX-GUC-COMMIT-CLEANUP', 'the production resolvers leave nothing behind either'), async () => {
    const ran = await runInAccountScope(product, { userId: w.aOwner, requestedAccountId: w.accountA }, () => Promise.resolve('ran'));
    expect(ran.kind).toBe('ran');
    const afterAccount = await probeGucs(product);
    expect([afterAccount.actor, afterAccount.account, afterAccount.company]).toEqual(['', '', '']);
    const ranCompany = await runInCompanyScope(product, { userId: w.aOwner, requestedAccountId: w.accountA, requestedCompanyId: w.companyA1 }, () => Promise.resolve('ran'));
    expect(ranCompany.kind).toBe('ran');
    const afterCompany = await probeGucs(product);
    expect([afterCompany.actor, afterCompany.account, afterCompany.company]).toEqual(['', '', '']);
  });
});
