// ACBP-P1-014 / CDR-020 — REAL HTTP ROUTE HANDLERS against a REAL database.
//
// Threat ids (shared inventory): AUTHZ-FORGED-CLERK-ROLE (trust-critical #20), SCOPE-SELECTOR-HARVESTED,
//             ORACLE-FOREIGN-ID, ORACLE-UNKNOWN-ID, ORACLE-MALFORMED-ID, ORACLE-ERROR-DETAIL,
//             AUTHZ-PLATFORM-ADMIN-NOT-TENANT, AUTHZ-TENANT-NOT-PLATFORM-ADMIN.
// Production entrypoints: the ACTUAL Next route modules under apps/web/src/app/api/**, invoked with real
//             `Request` objects. Everything below them is production — the request layer, the composed
//             ClerkIdentityRuntime, @acbp/core, @acbp/database and the restricted `acbp_app` connection.
// Proof level: HTTP → core → database, end to end.
// Real PostgreSQL is MANDATORY.
//
// WHY THIS FILE LIVES AT THE REPOSITORY ROOT: it must import BOTH apps/web (route handlers) and the database
// fixture. DEPENDENCY-BOUNDARIES forbids apps/web from importing @acbp/database and forbids packages/core
// from importing apps/web — correctly, because neither production edge should exist. A cross-layer test
// therefore belongs to no package; `tools/check-boundaries.mjs` scans apps/ + packages/ only, so a
// repo-level test creates no production dependency edge while still exercising the real stack.
//
// THE ONLY SEAM is the provider SDK at its edge: `@clerk/nextjs/server` is mocked so a deterministic
// verified session exists without calling live Clerk. The production authentication boundary
// (`resolveVerifiedIdentity`) still runs in full, and the mocked Backend User deliberately carries FORGED
// organization / role / admin-like values, so trust-critical #20 is exercised through the whole stack.
import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { DatabaseClient } from '@acbp/database';
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
  type TwoTenantWorld,
} from '../../../../../packages/core/src/tenancy/adversarial/two-tenant-harness.js';

/** The provider user id the mocked session presents. Mutated per test; read by the mock. */
let sessionProviderUserId = '';
/** Forged, browser-controllable claim soup on the Backend User. None of it may ever authorize. */
const FORGED_CLAIMS = {
  publicMetadata: { role: 'owner', admin: true, isPlatformAdmin: true, org_role: 'org:admin', accountId: 'FORGED-ACCOUNT', companyId: 'FORGED-COMPANY' },
  privateMetadata: { role: 'owner', platform_admin: true },
  unsafeMetadata: { role: 'owner' },
  organizationMemberships: [{ organization: { id: 'org_forged' }, role: 'org:admin' }],
  orgId: 'org_forged',
  orgRole: 'org:admin',
};

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
            ...FORGED_CLAIMS,
          }),
      },
    }),
}));

const UNKNOWN_UUID = '00000000-0000-4000-8000-0000000000ff';
const MALFORMED = ['not-a-uuid', "1' or '1'='1", '../../etc/passwd'] as const;
const APP_ROLE_TEST_PASSWORD = `adversarial_${'test'}_pw_1970`;

function jsonRequest(url: string, body?: unknown): Request {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

type ParamRoute<P> = { GET: (request: Request, context: { params: Promise<P> }) => Promise<Response> };
type ParamPostRoute<P> = { POST: (request: Request, context: { params: Promise<P> }) => Promise<Response> };

describe.skipIf(!hasTestDatabase)('HTTP routes against a real database — ACBP-P1-014/CDR-020', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let companiesRoute: { GET: (request: Request) => Promise<Response> };
  let companyRoute: ParamRoute<{ companyId: string }>;
  let pauseRoute: ParamPostRoute<{ companyId: string }>;
  let activityRoute: ParamRoute<{ companyId: string }>;
  let provisioningRoute: ParamRoute<{ companyId: string }>;
  let adminReadRoute: ParamPostRoute<{ accountId: string; companyId: string }>;

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    await assertRestrictedRole(product);

    // Point the PRODUCTION composition at the CI test database using the RESTRICTED role, with synthetic
    // (never real) Clerk configuration. The runtime is a lazily-built singleton, so this must happen before
    // the route modules are imported.
    const testDatabaseUrl = process.env['ACBP_TEST_DATABASE_URL'] ?? '';
    const url = new URL(testDatabaseUrl);
    url.username = 'acbp_app';
    url.password = APP_ROLE_TEST_PASSWORD;
    process.env['APP_ENV'] = 'test';
    process.env['DATABASE_APP_URL'] = url.toString();
    process.env['DATABASE_URL'] = testDatabaseUrl;
    process.env['DATABASE_SSL'] = process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable';
    process.env['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'] = 'pk_test_adversarial_synthetic';
    process.env['CLERK_SECRET_KEY'] = 'sk_test_adversarial_synthetic';
    process.env['CLERK_WEBHOOK_SIGNING_SECRET'] = 'whsec_adversarial_synthetic';
    process.env['CLERK_WEBHOOK_INSTANCE_ID'] = 'ins_adversarial';

    companiesRoute = await import('../../app/api/companies/route.js');
    companyRoute = await import('../../app/api/companies/[companyId]/route.js');
    pauseRoute = await import('../../app/api/companies/[companyId]/pause/route.js');
    activityRoute = await import('../../app/api/companies/[companyId]/activity/route.js');
    provisioningRoute = await import('../../app/api/companies/[companyId]/provisioning/route.js');
    adminReadRoute = await import('../../app/api/admin/accounts/[accountId]/companies/[companyId]/read/route.js');
  }, 90_000);
  afterAll(async () => {
    await teardown(owner, product);
  });
  beforeEach(async () => {
    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product);
  });

  /** Authenticate the next request as `internalUserId`, through the real identity boundary. */
  async function signInAs(internalUserId: string): Promise<void> {
    const row = await owner.kysely.selectFrom('users').select('provider_user_id').where('id', '=', internalUserId).executeTakeFirstOrThrow();
    sessionProviderUserId = row.provider_user_id;
  }

  // ── Trust-critical #20 ─────────────────────────────────────────────────────────────────────────────
  test('[AUTHZ-FORGED-CLERK-ROLE] HTTP → core → database — browser-controlled claims never authorize (trust-critical #20)', async () => {
    await signInAs(w.outsider); // a genuine outsider whose Backend User claims owner + admin + org role

    const detail = await companyRoute.GET(new Request(`https://app.test/api/companies/${w.companyA1}`), { params: Promise.resolve({ companyId: w.companyA1 }) });
    expect([401, 403, 404], 'forged claims must not grant company access').toContain(detail.status);

    const paused = await pauseRoute.POST(jsonRequest(`https://app.test/api/companies/${w.companyA1}/pause`), { params: Promise.resolve({ companyId: w.companyA1 }) });
    expect([401, 403, 404]).toContain(paused.status);

    const admin = await adminReadRoute.POST(jsonRequest(`https://app.test/api/admin/accounts/${w.accountA}/companies/${w.companyA1}/read`, { reason: 'Ticket #1: forged-claim probe' }), {
      params: Promise.resolve({ accountId: w.accountA, companyId: w.companyA1 }),
    });
    expect(admin.status, 'a forged admin claim must not satisfy the platform-admin gate').toBe(403);

    const adminAudits = await owner.kysely.selectFrom('audit_events').select('event_id').where('name', '=', 'admin.tenant_read').execute();
    expect(adminAudits, 'no admin action may be recorded for a forged claim').toEqual([]);
    const a1 = await owner.kysely.selectFrom('companies').select('status').where('id', '=', w.companyA1).executeTakeFirstOrThrow();
    expect(a1.status).not.toBe('paused');
  });

  test('[AUTHZ-FORGED-CLERK-ROLE] a legitimate caller still succeeds — the denials are about authority, not a broken path', async () => {
    await signInAs(w.aOwner);
    const detail = await companyRoute.GET(new Request(`https://app.test/api/companies/${w.companyA1}`), { params: Promise.resolve({ companyId: w.companyA1 }) });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { company?: { companyId?: string; name?: string } };
    expect(body.company?.companyId).toBe(w.companyA1);
    expect(body.company?.name).toBe('Alpha One');
  });

  // ── ID substitution / IDOR ─────────────────────────────────────────────────────────────────────────
  test('[SCOPE-SELECTOR-HARVESTED] IDOR across every company-scoped route — ids are selectors only, never authority', async () => {
    await signInAs(w.aOwner);
    for (const companyId of [w.companyB1, w.companyB2]) {
      const responses = [
        await companyRoute.GET(new Request(`https://app.test/api/companies/${companyId}`), { params: Promise.resolve({ companyId }) }),
        await activityRoute.GET(new Request(`https://app.test/api/companies/${companyId}/activity`), { params: Promise.resolve({ companyId }) }),
        await provisioningRoute.GET(new Request(`https://app.test/api/companies/${companyId}/provisioning`), { params: Promise.resolve({ companyId }) }),
        await pauseRoute.POST(jsonRequest(`https://app.test/api/companies/${companyId}/pause`), { params: Promise.resolve({ companyId }) }),
      ];
      for (const res of responses) {
        expect([403, 404], `route for ${companyId} must deny`).toContain(res.status);
        const text = await res.text();
        expect(text).not.toContain('Beta One');
        expect(text).not.toContain('Beta Two');
      }
    }
    const statuses = await owner.kysely.selectFrom('companies').select('status').where('account_id', '=', w.accountB).execute();
    expect(statuses.every((s) => s.status !== 'paused')).toBe(true);
  });

  test('[ORACLE-FOREIGN-ID][ORACLE-UNKNOWN-ID][ORACLE-MALFORMED-ID] foreign and unknown ids are byte-identical; malformed ids never succeed or leak', async () => {
    await signInAs(w.aOwner);
    const get = async (companyId: string): Promise<{ status: number; body: string }> => {
      const res = await companyRoute.GET(new Request(`https://app.test/api/companies/${companyId}`), { params: Promise.resolve({ companyId }) });
      return { status: res.status, body: await res.text() };
    };
    const foreign = await get(w.companyB1);
    const unknown = await get(UNKNOWN_UUID);
    expect(foreign.status, 'ORACLE-FOREIGN-ID vs ORACLE-UNKNOWN-ID: identical status').toBe(unknown.status);
    expect(foreign.body, 'ORACLE-FOREIGN-ID vs ORACLE-UNKNOWN-ID: identical body').toBe(unknown.body);
    // Malformed ids: the approved P1-014 policy allows a bounded validation/internal response rather than
    // the coarse denial — what must hold is that they never succeed, never execute the protected callback,
    // and never leak. (The bounded envelope itself is an ACBP-P1-014 Class R restoration: previously a
    // malformed id escaped the company routes as an uncaught PlatformError.)
    for (const bad of MALFORMED) {
      const r = await get(bad);
      expect(r.status, `malformed id '${bad}' must not succeed`).not.toBe(200);
      expect(Object.keys(JSON.parse(r.body) as Record<string, unknown>), `malformed id '${bad}' must yield a bounded envelope`).toEqual(['error']);
      for (const forbidden of ['select', 'insert', 'constraint', 'pg_', 'uuid', 'stack', 'password', w.companyB1]) {
        expect(r.body.toLowerCase(), `malformed-id response must not leak '${forbidden}'`).not.toContain(forbidden.toLowerCase());
      }
    }
  });

  test('[ORACLE-ERROR-DETAIL] every denial body is a bounded envelope carrying no tenant content', async () => {
    await signInAs(w.bViewer);
    const responses = [
      await companyRoute.GET(new Request(`https://app.test/api/companies/${w.companyA1}`), { params: Promise.resolve({ companyId: w.companyA1 }) }),
      await activityRoute.GET(new Request(`https://app.test/api/companies/${w.companyA1}/activity`), { params: Promise.resolve({ companyId: w.companyA1 }) }),
      await provisioningRoute.GET(new Request(`https://app.test/api/companies/${w.companyA1}/provisioning`), { params: Promise.resolve({ companyId: w.companyA1 }) }),
      await pauseRoute.POST(jsonRequest(`https://app.test/api/companies/${w.companyA1}/pause`), { params: Promise.resolve({ companyId: w.companyA1 }) }),
    ];
    for (const res of responses) {
      expect(res.status).not.toBe(200);
      const text = await res.text();
      expect(Object.keys(JSON.parse(text) as Record<string, unknown>), 'a denial body carries a single bounded error field').toEqual(['error']);
      for (const forbidden of ['Alpha One', 'Alpha Two', w.accountA, w.aOwner, 'select', 'constraint', 'pg_', 'stack']) {
        expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    }
  });

  // ── Enumeration ────────────────────────────────────────────────────────────────────────────────────
  test('[SCOPE-SELECTOR-HARVESTED] the portfolio route never enumerates another account', async () => {
    await signInAs(w.bOwner);
    const res = await companiesRoute.GET(new Request('https://app.test/api/companies'));
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const forbidden of ['Alpha One', 'Alpha Two', w.companyA1, w.companyA2]) expect(text).not.toContain(forbidden);
    const body = JSON.parse(text) as { items: { companyId: string }[] };
    expect(body.items.map((i) => i.companyId).sort()).toEqual([w.companyB1, w.companyB2].sort());
  });

  test('[ORACLE-MALFORMED-ID] unsupported or hostile query parameters never widen the portfolio', async () => {
    await signInAs(w.aOwner);
    for (const qs of [`?accountId=${w.accountB}`, '?filter=all', '?limit=1&evil=1']) {
      const res = await companiesRoute.GET(new Request(`https://app.test/api/companies${qs}`));
      expect([200, 400]).toContain(res.status);
      const text = await res.text();
      expect(text, `query '${qs}' must not reach account B`).not.toContain(w.companyB1);
      expect(text).not.toContain('Beta One');
    }
  });

  // ── Admin surface, negative only (CDR-020 §4) ──────────────────────────────────────────────────────
  test('[AUTHZ-TENANT-NOT-PLATFORM-ADMIN] tenant users cannot use the admin route and write no audit', async () => {
    for (const user of [w.aOwner, w.aViewer, w.bOwner, w.outsider, w.revokedPlatformAdmin]) {
      await signInAs(user);
      const res = await adminReadRoute.POST(jsonRequest(`https://app.test/api/admin/accounts/${w.accountA}/companies/${w.companyA1}/read`, { reason: 'Ticket #2: authority-confusion probe' }), {
        params: Promise.resolve({ accountId: w.accountA, companyId: w.companyA1 }),
      });
      expect(res.status, `${user} must be denied by the admin route`).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    }
    const audits = await owner.kysely.selectFrom('audit_events').select('event_id').where('name', '=', 'admin.tenant_read').execute();
    expect(audits).toEqual([]);
  });

  test('[AUTHZ-PLATFORM-ADMIN-NOT-TENANT] a real platform admin gains nothing on ordinary tenant routes', async () => {
    await signInAs(w.platformAdmin);
    const detail = await companyRoute.GET(new Request(`https://app.test/api/companies/${w.companyA1}`), { params: Promise.resolve({ companyId: w.companyA1 }) });
    expect([403, 404], 'platform authority is not tenant authority').toContain(detail.status);
    const activity = await activityRoute.GET(new Request(`https://app.test/api/companies/${w.companyA1}/activity`), { params: Promise.resolve({ companyId: w.companyA1 }) });
    expect([403, 404]).toContain(activity.status);
    const portfolio = await companiesRoute.GET(new Request('https://app.test/api/companies'));
    const portfolioText = await portfolio.text();
    expect(portfolioText).not.toContain(w.companyA1);
    expect(portfolioText).not.toContain('Alpha One');
  });

  test('[AUTHZ-TENANT-NOT-PLATFORM-ADMIN] a denied admin request has no side effects at all', async () => {
    await signInAs(w.aOwner);
    const before = await owner.kysely.selectFrom('audit_events').select('event_id').execute();
    await adminReadRoute.POST(jsonRequest(`https://app.test/api/admin/accounts/${w.accountA}/companies/${w.companyA1}/read`, { reason: 'Ticket #3: side-effect probe' }), {
      params: Promise.resolve({ accountId: w.accountA, companyId: w.companyA1 }),
    });
    const after = await owner.kysely.selectFrom('audit_events').select('event_id').execute();
    expect(after).toHaveLength(before.length);
    const activity = await owner.kysely.selectFrom('activity_events').select('activity_type').execute();
    expect(activity.every((a) => ['company.created', 'company.updated', 'company.paused', 'company.resumed'].includes(a.activity_type))).toBe(true);
  });
});
