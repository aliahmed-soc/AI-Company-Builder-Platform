// ACBP-P1-014 / CDR-020 — DETERMINISTIC CONCURRENCY adversarial suite.
//
// Threat ids: TX-CONCURRENT-ACCOUNTS, TX-CONCURRENT-COMPANIES, TX-GUC-ROLLBACK-CLEANUP.
// Production entrypoints: `withAccountTransaction`, `withTenantTransaction`, `getCompany`,
//             `getCompanyPortfolio`, plus the production repositories inside those scopes.
// Proof level: database primitive + core use case.
// Real PostgreSQL is MANDATORY: the risk is that two concurrent scopes share a pooled connection or a
// session-level GUC — only real connections can exhibit or refute that.
//
// DETERMINISM (CDR-020 §9): no sleeps, no timing assumptions, no retries. Interleaving is forced with an
// explicit barrier — every participant establishes its scope, signals arrival, and only proceeds once ALL
// participants have arrived. That guarantees the scopes are genuinely simultaneous rather than accidentally
// serialized, and it does so with promises rather than clocks.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { withAccountTransaction, withTenantTransaction, CompanyRepository, ActivityFeedRepository, type DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from './two-tenant-harness.js';
import { threatTitle } from './threat-inventory.js';
import { getCompany } from '../../company/company-lifecycle.js';
import { getCompanyPortfolio } from '../../company/portfolio-service.js';

/** A promise barrier: `arrive()` resolves for everyone only once `size` participants have arrived. */
function createBarrier(size: number): { arrive: () => Promise<void> } {
  let arrived = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    arrive: async () => {
      arrived += 1;
      if (arrived >= size) release();
      await gate;
    },
  };
}

describe.skipIf(!hasTestDatabase)('deterministic tenancy concurrency (real PostgreSQL, restricted role) — ACBP-P1-014/CDR-020', () => {
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

  test(threatTitle('TX-CONCURRENT-ACCOUNTS', 'A and B interleaved after scope setup'), async () => {
    const barrier = createBarrier(2);
    const read = async (accountId: string, actorId: string): Promise<{ account: string; pid: number; visible: string[] }> =>
      withAccountTransaction(product, { accountId, actorId }, async (scope) => {
        // Scope is established here; wait for the peer so both scopes are live simultaneously…
        await barrier.arrive();
        // …then query. If session state were shared, this is exactly where it would bleed.
        const ctx = await sql<{ account: string; pid: number }>`select current_setting('app.current_account', true) as account, pg_backend_pid() as pid`.execute(scope.db);
        const rows = await sql<{ id: string }>`select id from accounts order by id`.execute(scope.db);
        return { account: ctx.rows[0]!.account, pid: ctx.rows[0]!.pid, visible: rows.rows.map((r) => r.id) };
      });

    const [a, b] = await Promise.all([read(w.accountA, w.aOwner), read(w.accountB, w.bOwner)]);
    expect(a.pid, 'TX-CONCURRENT-ACCOUNTS A/B: simultaneous scopes must hold DIFFERENT pooled backends').not.toBe(b.pid);
    expect(a.account, `TX-CONCURRENT-ACCOUNTS: account A scope saw context '${a.account}'`).toBe(w.accountA);
    expect(b.account, `TX-CONCURRENT-ACCOUNTS: account B scope saw context '${b.account}'`).toBe(w.accountB);
    expect(a.visible, 'TX-CONCURRENT-ACCOUNTS A: must observe ONLY account A').toEqual([w.accountA]);
    expect(b.visible, 'TX-CONCURRENT-ACCOUNTS B: must observe ONLY account B').toEqual([w.accountB]);
  });

  test(threatTitle('TX-CONCURRENT-COMPANIES', 'A1/A2 same account and A1/B1 across accounts'), async () => {
    const read = async (barrier: { arrive: () => Promise<void> }, accountId: string, companyId: string, actorId: string): Promise<{ company: string; ids: string[]; pid: number }> =>
      withTenantTransaction(product, { accountId, companyId, actorId }, async (scope) => {
        await barrier.arrive();
        const ctx = await sql<{ company: string; pid: number }>`select current_setting('app.current_company', true) as company, pg_backend_pid() as pid`.execute(scope.db);
        const rows = await sql<{ id: string }>`select id from companies order by id`.execute(scope.db);
        return { company: ctx.rows[0]!.company, pid: ctx.rows[0]!.pid, ids: rows.rows.map((r) => r.id) };
      });

    // Same account, two companies — the dual key must still confine each to its own company row.
    const sameAccount = createBarrier(2);
    const [a1, a2] = await Promise.all([read(sameAccount, w.accountA, w.companyA1, w.aOwner), read(sameAccount, w.accountA, w.companyA2, w.aOwner)]);
    expect(a1.pid).not.toBe(a2.pid);
    expect(a1.company).toBe(w.companyA1);
    expect(a2.company).toBe(w.companyA2);
    expect(a1.ids, 'TX-CONCURRENT-COMPANIES A1/A2: A1 scope must see only A1').toEqual([w.companyA1]);
    expect(a2.ids, 'TX-CONCURRENT-COMPANIES A1/A2: A2 scope must see only A2').toEqual([w.companyA2]);

    // Across accounts, three-way.
    const crossAccount = createBarrier(3);
    const [x1, y1, y2] = await Promise.all([
      read(crossAccount, w.accountA, w.companyA1, w.aOwner),
      read(crossAccount, w.accountB, w.companyB1, w.bOwner),
      read(crossAccount, w.accountB, w.companyB2, w.bOwner),
    ]);
    expect(new Set([x1.pid, y1.pid, y2.pid]).size, 'three simultaneous scopes must hold three distinct backends').toBe(3);
    expect(x1.ids, 'TX-CONCURRENT-COMPANIES A1/B1: A1 must not see B rows').toEqual([w.companyA1]);
    expect(y1.ids, 'TX-CONCURRENT-COMPANIES A1/B1: B1 must not see A rows').toEqual([w.companyB1]);
    expect(y2.ids, 'TX-CONCURRENT-COMPANIES B1/B2: B2 must see only itself').toEqual([w.companyB2]);
  });

  test(threatTitle('TX-CONCURRENT-COMPANIES', 'concurrent production use cases return each caller their own company'), async () => {
    // The same assertion one layer up: real use cases, concurrently, for different tenants and actors.
    const [ra1, rb1, portfolioA, portfolioB] = await Promise.all([
      getCompany(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 }),
      getCompany(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1 }),
      getCompanyPortfolio(product, { userId: w.aOwner, accountId: w.accountA }),
      getCompanyPortfolio(product, { userId: w.bOwner, accountId: w.accountB }),
    ]);
    expect(ra1.status === 'ok' && ra1.company.companyId).toBe(w.companyA1);
    expect(rb1.status === 'ok' && rb1.company.companyId).toBe(w.companyB1);
    expect(ra1.status === 'ok' && ra1.company.name).toBe('Alpha One');
    expect(rb1.status === 'ok' && rb1.company.name).toBe('Beta One');
    const idsA = portfolioA.status === 'ok' ? portfolioA.page.items.map((i) => i.companyId).sort() : [];
    const idsB = portfolioB.status === 'ok' ? portfolioB.page.items.map((i) => i.companyId).sort() : [];
    expect(idsA, 'TX-CONCURRENT-COMPANIES portfolio A: only account A companies').toEqual([w.companyA1, w.companyA2].sort());
    expect(idsB, 'TX-CONCURRENT-COMPANIES portfolio B: only account B companies').toEqual([w.companyB1, w.companyB2].sort());
  });

  test(threatTitle('TX-GUC-ROLLBACK-CLEANUP', 'a failing tenant transaction cannot corrupt a simultaneous healthy one'), async () => {
    const barrier = createBarrier(2);
    const healthy = withTenantTransaction(product, { accountId: w.accountA, companyId: w.companyA1, actorId: w.aOwner }, async (scope) => {
      await barrier.arrive(); // both scopes live
      const before = await new CompanyRepository(scope.db).findById(w.companyA1);
      // The peer transaction rolls back while this one is mid-flight; this one must be unaffected.
      const activity = await new ActivityFeedRepository(scope.db).listByCompany(w.companyA1, 5);
      const after = await sql<{ company: string }>`select current_setting('app.current_company', true) as company`.execute(scope.db);
      return { before: before?.id, activityCompanies: [...new Set(activity.map((a) => a.company_id))], company: after.rows[0]!.company };
    });
    const failing = withTenantTransaction(product, { accountId: w.accountB, companyId: w.companyB1, actorId: w.bOwner }, async (scope) => {
      await barrier.arrive();
      await sql`select 1`.execute(scope.db);
      throw new Error('deliberate peer failure');
    });

    const [healthyResult, failedResult] = await Promise.allSettled([healthy, failing]);
    expect(failedResult.status).toBe('rejected');
    expect(healthyResult.status, 'TX-GUC-ROLLBACK-CLEANUP: the healthy A1 transaction must survive the B1 rollback').toBe('fulfilled');
    if (healthyResult.status !== 'fulfilled') return;
    expect(healthyResult.value.before).toBe(w.companyA1);
    expect(healthyResult.value.company).toBe(w.companyA1); // its context was never cleared by the peer
    expect(healthyResult.value.activityCompanies.every((c) => c === w.companyA1)).toBe(true);

    // Pooled reuse after the mixed outcome remains isolated and clean.
    const residual = await withTenantTransaction(product, { accountId: w.accountB, companyId: w.companyB1, actorId: w.bOwner }, async (scope) => {
      const rows = await sql<{ id: string }>`select id from companies order by id`.execute(scope.db);
      return rows.rows.map((r) => r.id);
    });
    expect(residual).toEqual([w.companyB1]);
  });
});
