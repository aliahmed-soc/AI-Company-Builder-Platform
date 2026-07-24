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
  runtimeConnectionRoles,
  configureRouteRuntimeEnv,
  runSliceAJourney,
  type TwoTenantWorld,
  type AdversarialDatabaseClient,
} from '@acbp/test-support';
import { provisionPersonalAccount, createCompany, pauseCompany } from '@acbp/core';

const CORE_SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

/** The provider user id the mocked session presents (the provider-edge seam). */
let sessionProviderUserId = '';
/** The primary email's verification status the provider reports. Mutable so ACC-001 can be tested NEGATIVELY. */
let sessionEmailVerification = 'verified';

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
            // makes the journey's first step a real assertion rather than a bypass. The status is mutable so
            // the rule is also proven negatively; a suite that only ever presents `verified` would still pass
            // if the check were deleted.
            emailAddresses: [{ id: 'e1', emailAddress: `${id}@example.com`, verification: { status: sessionEmailVerification } }],
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

    configureRouteRuntimeEnv();

    const companies = await import('../../app/api/companies/route.js');
    const company = await import('../../app/api/companies/[companyId]/route.js');
    const activity = await import('../../app/api/companies/[companyId]/activity/route.js');
    routes = { companiesGet: companies.GET, companiesPost: companies.POST, companyGet: company.GET, activityGet: activity.GET };
  }, 90_000);
  afterAll(async () => {
    await teardown(owner, product);
  });
  beforeEach(async () => {
    sessionEmailVerification = 'verified';
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
      foreignCompanyName: w.companyNames[2] ?? '',
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

  test('ACC-001 negatively: an UNVERIFIED primary email is refused, and creates nothing', async () => {
    // The journey's positive path always presents a verified email, so on its own it would still pass if the
    // rule were deleted. This is the step that makes the ACC-001 claim load-bearing.
    await signInAs(w.outsider);
    sessionEmailVerification = 'unverified';

    const listed = await routes.companiesGet(new Request('https://app.test/api/companies'));
    expect(listed.status, 'an unverified primary email must not authenticate').not.toBe(200);
    const created = await routes.companiesPost(new Request('https://app.test/api/companies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ creationMode: 'own_idea', name: 'Unverified Co' }) }));
    expect(created.status, 'an unverified primary email must not create a company').not.toBe(201);
    for (const res of [listed, created]) {
      expect(Object.keys((await res.json()) as Record<string, unknown>), 'the refusal is a bounded envelope').toEqual(['error']);
    }
    const profiles = await owner.kysely.selectFrom('company_profiles').select('company_id').where('name', '=', 'Unverified Co').execute();
    expect(profiles, 'the refused request must not have written anything').toHaveLength(0);
  }, 60_000);

  test('the route runtime serves the journey on the restricted role only (NFR-001)', async () => {
    // Env-level denial of DATABASE_URL is a precondition, not proof. This is the positive observation: after
    // the runtime has actually served requests, every backend it holds is `acbp_app`.
    await signInAs(w.outsider);
    expect((await routes.companiesGet(new Request('https://app.test/api/companies'))).status).toBe(200);
    const backends = await runtimeConnectionRoles(owner, ['acbp-adversarial-fixture', 'acbp-adversarial-app']);
    expect(backends.length, 'the runtime must hold at least one connection after serving a request').toBeGreaterThan(0);
    expect(backends.every((b) => b.role === 'acbp_app'), `route runtime connected as ${backends.map((b) => b.role).join(',')}`).toBe(true);
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
        for (const secret of [...w.companyNames, w.accountA, w.accountB]) {
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
