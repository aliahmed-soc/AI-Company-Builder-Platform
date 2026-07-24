// ACBP-P2-002 / CDR-023 — the interview Q&A ROUTES against a REAL database. Closes the gap the web unit tests
// (fake runtime) cannot: the real Next route handlers → composed ClerkIdentityRuntime → @acbp/core →
// @acbp/database → restricted acbp_app under FORCE RLS, with the provider SDK seamed at its edge and forged
// browser claims present. A question is seeded through the real core op so the answer route has a target.
//
// Proves end to end: a company member records/reads Q&A on the restricted role; every Q&A route DENIES a foreign
// tenant coarsely (403/404) with a bounded envelope leaking no foreign content EVEN WITH forged owner/admin
// claims; a malformed companyId/questionId is a bounded error, not a framework 500; an invalid answer body is a
// bounded 400; a query parameter is a bounded 400. Skips when ACBP_TEST_DATABASE_URL is unset.
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
import { provisionPersonalAccount, createCompany, pauseCompany, startInterviewSession, addInterviewQuestion } from '@acbp/core';

const CORE_SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

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
type QaGet = { GET: (request: Request, context: { params: Promise<{ companyId: string }> }) => Promise<Response> };
type AnswerPost = { POST: (request: Request, context: { params: Promise<{ companyId: string; questionId: string }> }) => Promise<Response> };

describe.skipIf(!hasTestDatabase)('interview Q&A routes against a real database — ACBP-P2-002/CDR-023', () => {
  let owner: AdversarialDatabaseClient;
  let product: AdversarialDatabaseClient;
  let w: TwoTenantWorld;
  let qaRoute: QaGet;
  let answerRoute: AnswerPost;

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    await assertRestrictedRole(product);
    configureRouteRuntimeEnv();
    qaRoute = await import('../../app/api/companies/[companyId]/interview/qa/route.js');
    answerRoute = await import('../../app/api/companies/[companyId]/interview/questions/[questionId]/answer/route.js');
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
  /** Start A1's session and seed one question through the real core ops; returns the question id. */
  async function seedQuestion(): Promise<string> {
    const started = await startInterviewSession(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
    if (started.status !== 'ok') throw new Error('could not start session');
    const q = await addInterviewQuestion(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, sessionId: started.session.sessionId, prompt: 'Q?' });
    if (q.status !== 'ok') throw new Error('could not add question');
    return q.question.questionId;
  }
  const getQa = (companyId: string) => qaRoute.GET(new Request(`https://app.test/api/companies/${companyId}/interview/qa`), { params: Promise.resolve({ companyId }) });
  const postAnswer = (companyId: string, questionId: string, body: unknown) =>
    answerRoute.POST(new Request(`https://app.test/api/companies/${companyId}/interview/questions/${questionId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ companyId, questionId }) });

  test('a company member records an answer and reads the Q&A on the restricted role', async () => {
    const q = await seedQuestion();
    await signInAs(w.aOwner);
    const rec = await postAnswer(w.companyA1, q, { status: 'answered', content: 'my answer' });
    expect(rec.status).toBe(200);
    expect(((await rec.json()) as { created?: boolean }).created).toBe(true);
    const read = await getQa(w.companyA1);
    expect(read.status).toBe(200);
    const body = (await read.json()) as { qa?: { items?: Array<{ currentAnswer?: { content?: string } }> } };
    expect(body.qa?.items?.[0]?.currentAnswer?.content).toBe('my answer');
  });

  test('every Q&A route DENIES a foreign tenant, even with forged owner/admin claims — bounded, no leak', async () => {
    const q = await seedQuestion();
    // The outsider targets account A's company A1 with forged owner claims naming the real target.
    await signInAs(w.outsider);
    setForgedClaims({ accountId: w.accountA, companyId: w.companyA1 });
    for (const call of [() => getQa(w.companyA1), () => postAnswer(w.companyA1, q, { status: 'answered', content: 'x' })]) {
      const res = await call();
      expect([403, 404], 'foreign Q&A must be denied').toContain(res.status);
      const text = await res.text();
      for (const secret of ['my answer', 'Q?', w.accountA, w.aOwner]) expect(text).not.toContain(secret);
    }
    // Nothing was written for A1 by the outsider.
    expect(await owner.kysely.selectFrom('interview_answers').selectAll().where('company_id', '=', w.companyA1).execute()).toHaveLength(0);
  });

  test('malformed companyId / questionId is a bounded error envelope, never a framework 500', async () => {
    await signInAs(w.aOwner);
    for (const bad of MALFORMED) {
      const g = await getQa(bad);
      expect(g.status).toBeGreaterThanOrEqual(400);
      expect(Object.keys((await g.json()) as Record<string, unknown>)).toEqual(['error']);
      const a = await postAnswer(bad, bad, { status: 'answered', content: 'x' });
      expect(a.status).toBeGreaterThanOrEqual(400);
      expect(Object.keys((await a.json()) as Record<string, unknown>)).toEqual(['error']);
    }
  });

  test('an invalid answer body is a bounded 400; a query parameter is a bounded 400', async () => {
    const q = await seedQuestion();
    await signInAs(w.aOwner);
    // answered with no content → domain validation 400.
    expect((await postAnswer(w.companyA1, q, { status: 'answered' })).status).toBe(400);
    // skipped with content → validation 400.
    expect((await postAnswer(w.companyA1, q, { status: 'skipped', content: 'x' })).status).toBe(400);
    // a query parameter is rejected before anything else.
    const withQuery = await answerRoute.POST(new Request(`https://app.test/api/companies/${w.companyA1}/interview/questions/${q}/answer?x=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), { params: Promise.resolve({ companyId: w.companyA1, questionId: q }) });
    expect(withQuery.status).toBe(400);
    expect((await getQa(`${w.companyA1}`).then((r) => r.status))).toBe(200); // sanity: the valid path still works
  });
});
