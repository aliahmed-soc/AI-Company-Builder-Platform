// ACBP-P2-001 / CDR-022 — the interview session ROUTES against a REAL database. Closes the gap the web unit
// tests (fake runtime) cannot: the real Next route handlers → composed ClerkIdentityRuntime → @acbp/core →
// @acbp/database → restricted acbp_app under FORCE RLS. The only seam is the provider SDK at its edge, so the
// production authentication boundary (verified primary email) runs in full, and forged browser claims are
// present on the Backend User to prove they never authorize.
//
// Proves, end to end: a company member starts/reads/suspends/resumes; the runtime holds only the restricted
// role; every route DENIES a foreign tenant and an outsider coarsely (403/404) with a bounded envelope leaking
// no foreign names/ids — even with forged owner/admin claims; a malformed companyId is a bounded error, not a
// framework 500; start on a paused company is a coarse 409. Skips when ACBP_TEST_DATABASE_URL is unset.
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
  type TwoTenantWorld,
  type AdversarialDatabaseClient,
} from '@acbp/test-support';
import { provisionPersonalAccount, createCompany, pauseCompany } from '@acbp/core';

const CORE_SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

let sessionProviderUserId = '';
let forgedClaims: Record<string, unknown> = {};
function setForgedClaims(target: { accountId: string; companyId: string }): void {
  forgedClaims = {
    publicMetadata: { role: 'owner', admin: true, accountId: target.accountId, companyId: target.companyId },
    privateMetadata: { role: 'owner', accountId: target.accountId },
    orgId: target.accountId,
    orgRole: 'org:admin',
  };
}

vi.mock('@clerk/nextjs/server', () => ({
  auth: () => Promise.resolve({ userId: sessionProviderUserId }),
  clerkClient: () =>
    Promise.resolve({
      users: {
        getUser: (id: string) =>
          Promise.resolve({
            id,
            primaryEmailAddressId: 'e1',
            emailAddresses: [{ id: 'e1', emailAddress: `${id}@example.com`, verification: { status: 'verified' } }],
            firstName: 'Test',
            lastName: 'User',
            ...forgedClaims,
          }),
      },
    }),
}));

const MALFORMED = ['not-a-uuid', "1' or '1'='1", '../../etc/passwd'] as const;
type ParamPost = { POST: (request: Request, context: { params: Promise<{ companyId: string }> }) => Promise<Response> };
type ParamGet = { GET: (request: Request, context: { params: Promise<{ companyId: string }> }) => Promise<Response> };

describe.skipIf(!hasTestDatabase)('interview routes against a real database — ACBP-P2-001/CDR-022', () => {
  let owner: AdversarialDatabaseClient;
  let product: AdversarialDatabaseClient;
  let w: TwoTenantWorld;
  let interviewRoute: ParamGet & ParamPost;
  let suspendRoute: ParamPost;
  let resumeRoute: ParamPost;

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    await assertRestrictedRole(product);
    configureRouteRuntimeEnv();
    interviewRoute = await import('../../app/api/companies/[companyId]/interview/route.js');
    suspendRoute = await import('../../app/api/companies/[companyId]/interview/suspend/route.js');
    resumeRoute = await import('../../app/api/companies/[companyId]/interview/resume/route.js');
  }, 90_000);
  afterAll(async () => {
    await teardown(owner, product);
  });
  beforeEach(async () => {
    forgedClaims = {};
    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product, CORE_SEED_OPS);
  });

  async function signInAs(internalUserId: string): Promise<void> {
    const row = await owner.kysely.selectFrom('users').select('provider_user_id').where('id', '=', internalUserId).executeTakeFirstOrThrow();
    sessionProviderUserId = row.provider_user_id;
  }
  const sessionState = async (res: Response): Promise<string | undefined> => ((await res.json()) as { session?: { state?: string } }).session?.state;
  const errorOf = async (res: Response): Promise<string | undefined> => ((await res.json()) as { error?: string }).error;
  const get = (companyId: string) => interviewRoute.GET(new Request(`https://app.test/api/companies/${companyId}/interview`), { params: Promise.resolve({ companyId }) });
  const start = (companyId: string) => interviewRoute.POST(new Request(`https://app.test/api/companies/${companyId}/interview`, { method: 'POST' }), { params: Promise.resolve({ companyId }) });
  const suspend = (companyId: string) => suspendRoute.POST(new Request(`https://app.test/api/companies/${companyId}/interview/suspend`, { method: 'POST' }), { params: Promise.resolve({ companyId }) });
  const resume = (companyId: string) => resumeRoute.POST(new Request(`https://app.test/api/companies/${companyId}/interview/resume`, { method: 'POST' }), { params: Promise.resolve({ companyId }) });

  test('a company member drives the full route journey: start → get → suspend → resume, on the restricted role', async () => {
    await signInAs(w.aOwner);
    const started = await start(w.companyA1);
    expect(started.status).toBe(200);
    expect(await sessionState(started)).toBe('in_progress');

    expect(await sessionState(await get(w.companyA1))).toBe('in_progress');
    expect(await sessionState(await suspend(w.companyA1))).toBe('waiting_for_user');
    expect(await sessionState(await resume(w.companyA1))).toBe('in_progress');

    // The route runtime served everything on the restricted role only.
    const backends = await runtimeConnectionRoles(owner, ['acbp-adversarial-fixture', 'acbp-adversarial-app']);
    expect(backends.length).toBeGreaterThan(0);
    expect(backends.every((b) => b.role === 'acbp_app')).toBe(true);
  });

  test('every interview route DENIES a foreign tenant, even with forged owner/admin claims — bounded, no leak', async () => {
    // The outsider builds his own account (any authenticated user), then targets account A's company A1 while
    // presenting forged owner claims naming the REAL target tenant.
    await signInAs(w.outsider);
    setForgedClaims({ accountId: w.accountA, companyId: w.companyA1 });
    for (const call of [() => get(w.companyA1), () => start(w.companyA1), () => suspend(w.companyA1), () => resume(w.companyA1)]) {
      const res = await call();
      expect([403, 404], 'foreign company must be denied').toContain(res.status);
      const text = await res.text();
      for (const secret of [...w.companyNames, w.accountA, w.aOwner]) expect(text).not.toContain(secret);
    }
    // Nothing was written for company A1 by the outsider.
    expect(await owner.kysely.selectFrom('interview_sessions').selectAll().where('company_id', '=', w.companyA1).execute()).toHaveLength(0);
  });

  test('a malformed companyId is a bounded error envelope, never a framework 500', async () => {
    await signInAs(w.aOwner);
    for (const bad of MALFORMED) {
      for (const call of [() => get(bad), () => start(bad), () => suspend(bad), () => resume(bad)]) {
        const res = await call();
        expect(res.status, `malformed ${bad}`).toBeGreaterThanOrEqual(400);
        const body = (await res.json()) as Record<string, unknown>;
        expect(Object.keys(body)).toEqual(['error']); // bounded envelope, no stack/SQL/constraint text
      }
    }
  });

  test('start on a PAUSED company is a coarse 409 (company_not_active) and writes nothing', async () => {
    await signInAs(w.bOwner); // bOwner owns the paused company B2
    const res = await start(w.companyB2);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('company_not_active');
    expect(await owner.kysely.selectFrom('interview_sessions').selectAll().where('company_id', '=', w.companyB2).execute()).toHaveLength(0);
  });

  test('any query parameter is rejected with a bounded 400 (no body/params surface)', async () => {
    await signInAs(w.aOwner);
    const res = await interviewRoute.POST(new Request(`https://app.test/api/companies/${w.companyA1}/interview?x=1`, { method: 'POST' }), { params: Promise.resolve({ companyId: w.companyA1 }) });
    expect(res.status).toBe(400);
  });
});
