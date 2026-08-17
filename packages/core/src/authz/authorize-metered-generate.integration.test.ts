// ACBP-API-008 / CDR-092 §15 — real-PostgreSQL proof that authorizeMeteredGenerate refuses a
// viewer and a non-member, and admits an owner, for each of the four generate actions.
//
// This is the other half of the company-bucket gate. The request-layer suite proves that a
// `forbidden` from this function leaves the company bucket untouched. This suite proves the
// function actually returns `forbidden` for the callers the ruling named. Either half alone
// can be green while the drain is still live.
//
// Skips when ACBP_TEST_DATABASE_URL is unset. Hosted CI is the evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import type { DatabaseClient } from '@acbp/database';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { authorizeMeteredGenerate, METERED_GENERATE_ACTIONS } from './authorize-metered-generate.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

describe.skipIf(!hasTestDatabase)('authorizeMeteredGenerate (real PostgreSQL) — CDR-092 §15', () => {
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
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);
  });

  test.each([...METERED_GENERATE_ACTIONS])('%s — an owner is allowed', async (action) => {
    await expect(
      authorizeMeteredGenerate(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, action }),
    ).resolves.toBe('allowed');
  });

  test.each([...METERED_GENERATE_ACTIONS])('%s — a viewer is forbidden', async (action) => {
    await expect(
      authorizeMeteredGenerate(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, action }),
    ).resolves.toBe('forbidden');
  });

  test.each([...METERED_GENERATE_ACTIONS])('%s — a non-member is forbidden', async (action) => {
    // bOwner is an owner of a different company. They are authenticated and have an account.
    // That is the caller the drain was demonstrated with.
    await expect(
      authorizeMeteredGenerate(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1, action }),
    ).resolves.toBe('forbidden');
  });
});
