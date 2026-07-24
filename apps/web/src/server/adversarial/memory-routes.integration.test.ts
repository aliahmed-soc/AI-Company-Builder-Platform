// ACBP-P2-006 / CDR-024 — the typed-memory ROUTES against a REAL database. Closes the gap the web unit tests
// (fake runtime) cannot: the real Next route handlers → composed ClerkIdentityRuntime → @acbp/core →
// @acbp/database → restricted acbp_app under FORCE RLS, with the provider SDK seamed at its edge and forged
// browser claims present.
//
// Proves end to end: a company member creates + lists memory on the restricted role; every memory route DENIES
// a foreign tenant coarsely (403) with a bounded envelope leaking no foreign content/ids EVEN WITH forged
// owner/admin claims; a request cannot forge account/company/actor (server-scoped); incompatible type/source is
// a bounded 400 (a generated source cannot become user_fact); the audit event is target-tenant scoped; the
// response carries no source-tenant data; a malformed companyId is bounded (not a framework 500); a query
// parameter is a bounded 400; and there is NO supersede/delete verb. Skips when ACBP_TEST_DATABASE_URL is unset.
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
  configureRouteRuntimeEnv,
  type TwoTenantWorld,
  type AdversarialDatabaseClient,
} from '@acbp/test-support';
import { provisionPersonalAccount, createCompany, pauseCompany } from '@acbp/core';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

let sessionProviderUserId = '';
let forgedClaims: Record<string, unknown> = {};
function setForgedClaims(target: { accountId: string; companyId: string }): void {
  forgedClaims = { publicMetadata: { role: 'owner', admin: true, accountId: target.accountId, companyId: target.companyId }, orgId: target.accountId, orgRole: 'org:admin' };
}

vi.mock('@clerk/nextjs/server', () => ({
  auth: () => Promise.resolve({ userId: sessionProviderUserId }),
  clerkClient: () =>
    Promise.resolve({
      users: {
        getUser: (id: string) => Promise.resolve({ id, primaryEmailAddressId: 'e1', emailAddresses: [{ id: 'e1', emailAddress: `${id}@example.com`, verification: { status: 'verified' } }], firstName: 'Test', lastName: 'User', ...forgedClaims }),
      },
    }),
}));

const MALFORMED = ['not-a-uuid', "1' or '1'='1"] as const;
type MemoryRoute = {
  GET: (request: Request, context: { params: Promise<{ companyId: string }> }) => Promise<Response>;
  POST: (request: Request, context: { params: Promise<{ companyId: string }> }) => Promise<Response>;
};
const FACT = { type: 'user_fact', content: 'The founder is in Cairo.', sourceType: 'interview_answer', sourceRef: 'q1:1' };

describe.skipIf(!hasTestDatabase)('typed memory routes against a real database — ACBP-P2-006/CDR-024', () => {
  let owner: AdversarialDatabaseClient;
  let product: AdversarialDatabaseClient;
  let w: TwoTenantWorld;
  let route: MemoryRoute;

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    await assertRestrictedRole(product);
    configureRouteRuntimeEnv();
    route = await import('../../app/api/companies/[companyId]/memory/route.js');
  }, 90_000);
  afterAll(async () => {
    await teardown(owner, product);
  });
  beforeEach(async () => {
    forgedClaims = {};
    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);
  });

  async function signInAs(internalUserId: string): Promise<void> {
    const row = await owner.kysely.selectFrom('users').select('provider_user_id').where('id', '=', internalUserId).executeTakeFirstOrThrow();
    sessionProviderUserId = row.provider_user_id;
  }
  const list = (companyId: string) => route.GET(new Request(`https://app.test/api/companies/${companyId}/memory`), { params: Promise.resolve({ companyId }) });
  const create = (companyId: string, body: unknown) =>
    route.POST(new Request(`https://app.test/api/companies/${companyId}/memory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ companyId }) });

  test('a company member creates a typed item and lists it on the restricted role', async () => {
    await signInAs(w.aOwner);
    const c = await create(w.companyA1, FACT);
    expect(c.status).toBe(201);
    const created = (await c.json()) as { item?: { type?: string; sourceType?: string } };
    expect(created.item?.type).toBe('user_fact');
    expect(created.item?.sourceType).toBe('interview_answer');
    const l = await list(w.companyA1);
    expect(l.status).toBe(200);
    const body = (await l.json()) as { items?: Array<{ content?: string }> };
    expect(body.items?.[0]?.content).toBe('The founder is in Cairo.');
    // The audit event is target-tenant scoped, not leaked to B.
    const audits = await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'memory.item_created').execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.company_id).toBe(w.companyA1);
    expect(audits[0]!.account_id).toBe(w.accountA);
  });

  test('every memory route DENIES a foreign tenant, even with forged owner/admin claims — bounded, no leak', async () => {
    await signInAs(w.aOwner);
    await create(w.companyA1, { ...FACT, content: 'secret memory' });
    // The outsider targets A1 with forged owner claims naming the real target.
    await signInAs(w.outsider);
    setForgedClaims({ accountId: w.accountA, companyId: w.companyA1 });
    for (const call of [() => list(w.companyA1), () => create(w.companyA1, FACT)]) {
      const res = await call();
      expect([403, 404], 'foreign memory must be denied').toContain(res.status);
      const text = await res.text();
      for (const secret of ['secret memory', 'The founder is in Cairo', w.accountA, w.aOwner]) expect(text).not.toContain(secret);
    }
    // Nothing new was written for A1 by the outsider (still exactly the one owner-created item).
    expect(await owner.kysely.selectFrom('memory_items').selectAll().where('company_id', '=', w.companyA1).execute()).toHaveLength(1);
  });

  test('a request cannot forge account/company/actor: extra body fields are ignored, scope is server-resolved', async () => {
    await signInAs(w.aOwner);
    // A create body laden with foreign account/company/actor + a forged admin flag: the route reads ONLY the
    // typed-memory fields; account/company/actor come from the server scope, so the item lands in A1 as aOwner.
    const res = await create(w.companyA1, { ...FACT, accountId: w.accountB, companyId: w.companyB1, createdByUserId: w.bOwner, actor: w.bOwner, admin: true });
    expect(res.status).toBe(201);
    const rows = await owner.kysely.selectFrom('memory_items').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.company_id).toBe(w.companyA1);
    expect(rows[0]!.account_id).toBe(w.accountA);
    expect(rows[0]!.created_by_user_id).toBe(w.aOwner);
  });

  test('incompatible type/source is a bounded 400 (a generated source cannot become user_fact)', async () => {
    await signInAs(w.aOwner);
    expect((await create(w.companyA1, { ...FACT, sourceType: 'model_generation' })).status).toBe(400);
    expect((await create(w.companyA1, { ...FACT, type: 'opinion' })).status).toBe(400);
    expect((await create(w.companyA1, { ...FACT, sourceRef: '' })).status).toBe(400);
    // The valid generated-assumption path is accepted.
    expect((await create(w.companyA1, { type: 'ai_assumption', content: 'assumed', sourceType: 'model_generation', sourceRef: 'run:1' })).status).toBe(201);
  });

  test('malformed companyId is a bounded {error} envelope; a query parameter is a bounded 400; no supersede/delete verb', async () => {
    await signInAs(w.aOwner);
    for (const bad of MALFORMED) {
      const g = await list(bad);
      expect(g.status).toBeGreaterThanOrEqual(400);
      expect(Object.keys((await g.json()) as Record<string, unknown>)).toEqual(['error']);
    }
    // A query parameter is rejected before anything else.
    const withQuery = await route.GET(new Request(`https://app.test/api/companies/${w.companyA1}/memory?type=user_fact`), { params: Promise.resolve({ companyId: w.companyA1 }) });
    expect(withQuery.status).toBe(400);
    // The route exposes only GET + POST — no PATCH/DELETE (supersede/delete are P2-010).
    const r = route as unknown as Record<string, unknown>;
    expect(typeof r['PATCH']).toBe('undefined');
    expect(typeof r['DELETE']).toBe('undefined');
    expect(typeof r['PUT']).toBe('undefined');
  });
});
