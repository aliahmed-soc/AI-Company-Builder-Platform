// ACBP-P1-015 / CDR-021 — SLICE A end-to-end: secure company creation.
//
// The M1 exit criterion, executable: sign in → internal mapping → account → company → switch →
// cross-company access DENIED (the live adversarial demo), with the audit/activity trail verified.
//
// Production entrypoints: the ACTUAL Next route modules, over the composed ClerkIdentityRuntime, @acbp/core,
// @acbp/database and the restricted `acbp_app` connection against real PostgreSQL. The only seam is the
// provider SDK at its edge (`@clerk/nextjs/server`), so the production authentication boundary —
// `resolveVerifiedIdentity`, including the verified-primary-email rule — still executes in full.
//
// Requirements: ACC-001, ACC-002 (sign-in + verified email + internal mapping), COMP-001 (creation),
// PORT-003 (switching without context bleed), NFR-001 (tenant isolation). ADR-007, ADR-022.
//
// The journey itself lives in @acbp/test-support (`runSliceAJourney`) and is shared with the runnable demo
// script (`pnpm demo:slice-a`), so the demo and the CI guarantee can never drift. This file owns the
// lifecycle and turns each step's verdict into an assertion; the script prints the same verdicts.
import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  hasTestDatabase,
  createOwnerFixtureClient,
  createRestrictedProductClient,
  enableAppLogin,
  resetSchema,
  truncateFixtures,
  seedTwoTenantWorld,
  teardown,
  assertRestrictedRole,
  runSliceAJourney,
  APP_ROLE_TEST_PASSWORD,
  type TwoTenantWorld,
  type AdversarialDatabaseClient,
} from '@acbp/test-support';
import { provisionPersonalAccount, createCompany, pauseCompany } from '@acbp/core';

const CORE_SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

/** The provider user id the mocked session presents (the provider-edge seam). */
let sessionProviderUserId = '';

vi.mock('@clerk/nextjs/server', () => ({
  auth: () => Promise.resolve({ userId: sessionProviderUserId }),
  clerkClient: () =>
    Promise.resolve({
      users: {
        getUser: (id: string) =>
          Promise.resolve({
            id,
            primaryEmailAddressId: 'e1',
            // The production boundary REQUIRES a verified primary email (ACC-001) — supplying it here is what
            // makes the journey's first step a real assertion rather than a bypass.
            emailAddresses: [{ id: 'e1', emailAddress: `${id}@example.com`, verification: { status: 'verified' } }],
            firstName: 'Slice',
            lastName: 'A',
          }),
      },
    }),
}));

describe.skipIf(!hasTestDatabase)('Slice A: secure company creation, end to end — ACBP-P1-015/CDR-021', () => {
  let owner: AdversarialDatabaseClient;
  let product: AdversarialDatabaseClient;
  let w: TwoTenantWorld;
  let routes: Parameters<typeof runSliceAJourney>[0]['routes'];

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    await assertRestrictedRole(product);

    const testDatabaseUrl = process.env['ACBP_TEST_DATABASE_URL'] ?? '';
    const url = new URL(testDatabaseUrl);
    url.username = 'acbp_app';
    url.password = APP_ROLE_TEST_PASSWORD;
    process.env['APP_ENV'] = 'test';
    process.env['DATABASE_APP_URL'] = url.toString();
    delete process.env['DATABASE_URL']; // the owner connection must not be reachable by the runtime
    process.env['DATABASE_SSL'] = process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable';
    process.env['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'] = 'pk_test_slice_a_synthetic';
    process.env['CLERK_SECRET_KEY'] = 'sk_test_slice_a_synthetic';
    process.env['CLERK_WEBHOOK_SIGNING_SECRET'] = 'whsec_slice_a_synthetic';
    process.env['CLERK_WEBHOOK_INSTANCE_ID'] = 'ins_adversarial';

    const companies = await import('../../app/api/companies/route.js');
    const company = await import('../../app/api/companies/[companyId]/route.js');
    const activity = await import('../../app/api/companies/[companyId]/activity/route.js');
    routes = { companiesGet: companies.GET, companiesPost: companies.POST, companyGet: company.GET, activityGet: activity.GET };
  }, 90_000);
  afterAll(async () => {
    await teardown(owner, product);
  });
  beforeEach(async () => {
    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product, CORE_SEED_OPS);
  });

  async function signInAs(internalUserId: string): Promise<void> {
    const row = await owner.kysely.selectFrom('users').select('provider_user_id').where('id', '=', internalUserId).executeTakeFirstOrThrow();
    sessionProviderUserId = row.provider_user_id;
  }

  test('the full journey passes, ending in a live cross-tenant denial', async () => {
    // The protagonist is an OUTSIDER to the fixture's two tenants — he arrives with nothing and builds his
    // own account and company through the real routes, which is exactly the M1 story. Account B is the
    // unrelated tenant used for the live denial.
    const result = await runSliceAJourney({
      signInAs,
      routes,
      owner,
      actorUserId: w.outsider,
      foreignCompanyId: w.companyB1,
      foreignCompanyName: 'Beta One',
      foreignAccountId: w.accountB,
    });

    // Report EVERY step, so a failure names the step and its requirement rather than a bare boolean.
    for (const step of result.steps) {
      expect(step.ok, `[${step.requirement}] ${step.step} — ${step.detail}`).toBe(true);
    }
    expect(result.companyId, 'the journey must have created a company').not.toBeNull();
    // Every requirement the backlog row names is represented by at least one executed step.
    const covered = new Set(result.steps.flatMap((s) => s.requirement.split('/')));
    for (const requirement of ['ACC-001', 'ACC-002', 'COMP-001', 'PORT-003', 'NFR-001']) {
      expect(covered.has(requirement), `requirement ${requirement} is unrepresented in the journey`).toBe(true);
    }
  }, 60_000);

  test('the negative set: every company-scoped route refuses the other tenant, and nothing leaks', async () => {
    await signInAs(w.outsider);
    const created = await routes.companiesPost(new Request('https://app.test/api/companies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ creationMode: 'own_idea', name: 'Negative Set Co' }) }));
    expect(created.status).toBe(201);

    for (const foreignId of [w.companyB1, w.companyB2, w.companyA1]) {
      const detail = await routes.companyGet(new Request(`https://app.test/api/companies/${foreignId}`), { params: Promise.resolve({ companyId: foreignId }) });
      const activity = await routes.activityGet(new Request(`https://app.test/api/companies/${foreignId}/activity`), { params: Promise.resolve({ companyId: foreignId }) });
      for (const res of [detail, activity]) {
        expect([403, 404], `foreign company ${foreignId} must be denied`).toContain(res.status);
        const text = await res.text();
        expect(Object.keys(JSON.parse(text) as Record<string, unknown>), 'the denial is a bounded envelope').toEqual(['error']);
        for (const secret of ['Alpha One', 'Alpha Two', 'Beta One', 'Beta Two', w.accountA, w.accountB]) {
          expect(text).not.toContain(secret);
        }
      }
    }
    // The other tenants' data is untouched by the whole journey.
    const foreignCompanies = await owner.kysely.selectFrom('companies').select(['id', 'status']).where('account_id', 'in', [w.accountA, w.accountB]).execute();
    expect(foreignCompanies.filter((c) => c.id === w.companyB2).every((c) => c.status === 'paused')).toBe(true);
    expect(foreignCompanies.filter((c) => c.id !== w.companyB2).every((c) => c.status === 'active')).toBe(true);
  }, 60_000);

  test('all three creation modes complete the journey’s creation step (COMP-001)', async () => {
    await signInAs(w.outsider);
    for (const creationMode of ['own_idea', 'platform_suggested', 'existing_business'] as const) {
      const res = await routes.companiesPost(new Request('https://app.test/api/companies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ creationMode, name: `Mode ${creationMode}` }) }));
      expect(res.status, `creation mode ${creationMode} must be accepted`).toBe(201);
      const body = (await res.json()) as { company?: { creationMode?: string } };
      expect(body.company?.creationMode).toBe(creationMode);
    }
    const portfolio = await routes.companiesGet(new Request('https://app.test/api/companies'));
    const page = (await portfolio.json()) as { items: { companyId: string }[] };
    expect(page.items).toHaveLength(3); // PORT-003: exactly the caller's own three, no bleed
  }, 60_000);
});
