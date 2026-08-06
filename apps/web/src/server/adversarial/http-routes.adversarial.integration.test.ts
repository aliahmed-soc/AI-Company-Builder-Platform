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
// PLACEMENT: this suite drives apps/web route handlers against a real database, so it must reach both the
// web layer and a database fixture. The fixture lives in @acbp/test-support — the package the scaffold spec
// designates for "fixtures, fakes, adversarial harnesses (never in production bundles)" — which the
// dependency-boundary checker allows TEST files (only) to import from any layer, while production code may
// never depend on it. No production dependency edge is created.
//
// THE ONLY SEAM is the provider SDK at its edge: `@clerk/nextjs/server` is mocked so a deterministic
// verified session exists without calling live Clerk. The production authentication boundary
// (`resolveVerifiedIdentity`) still runs in full, and the mocked Backend User deliberately carries FORGED
// organization / role / admin-like values, so trust-critical #20 is exercised through the whole stack.
import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** The production use cases the fixture seeds through (injected — test-support may not import core). */
const CORE_SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

/** The provider user id the mocked session presents. Mutated per test; read by the mock. */
let sessionProviderUserId = '';

/**
 * Forged, browser-controllable claims on the Backend User. MUTABLE and populated per test with the REAL
 * fixture ids of the tenant under attack.
 *
 * Why that matters: with placeholder values (`accountId: 'FORGED-ACCOUNT'`) a regression that started
 * trusting `publicMetadata.accountId` would resolve to a nonexistent account and still deny — the test
 * would stay green while a full claim-trusting bypass shipped. Naming the real target means "claim
 * honoured" necessarily becomes "cross-tenant data returned", which fails.
 */
let forgedClaims: Record<string, unknown> = {};
function setForgedClaims(target: { accountId: string; companyId: string }): void {
  forgedClaims = {
    publicMetadata: { role: 'owner', admin: true, isPlatformAdmin: true, org_role: 'org:admin', accountId: target.accountId, companyId: target.companyId },
    privateMetadata: { role: 'owner', platform_admin: true, accountId: target.accountId },
    unsafeMetadata: { role: 'owner', companyId: target.companyId },
    organizationMemberships: [{ organization: { id: target.accountId }, role: 'org:admin' }],
    orgId: target.accountId,
    orgRole: 'org:admin',
  };
}

vi.mock('@clerk/nextjs/server', () => ({
  // ACBP-P7-013: a real `auth()` carries a sessionId whenever it carries a userId, and the per-session
  // ceiling is keyed on it. Stubbed here so these suites exercise the PRIMARY path rather than the user-id
  // fallback; the fallback has its own cases in verified-identity.test.ts.
  auth: () => Promise.resolve({ userId: sessionProviderUserId, sessionId: `sess_${sessionProviderUserId}` }),
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

const UNKNOWN_UUID = '00000000-0000-4000-8000-0000000000ff';
const MALFORMED = ['not-a-uuid', "1' or '1'='1", '../../etc/passwd'] as const;


function jsonRequest(url: string, body?: unknown): Request {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

type ParamRoute<P> = { GET: (request: Request, context: { params: Promise<P> }) => Promise<Response> };
type ParamPostRoute<P> = { POST: (request: Request, context: { params: Promise<P> }) => Promise<Response> };

describe.skipIf(!hasTestDatabase)('HTTP routes against a real database — ACBP-P1-014/CDR-020', () => {
  let owner: AdversarialDatabaseClient;
  let product: AdversarialDatabaseClient;
  let w: TwoTenantWorld;
  let companiesRoute: { GET: (request: Request) => Promise<Response> };
  let companyRoute: ParamRoute<{ companyId: string }>;
  let pauseRoute: ParamPostRoute<{ companyId: string }>;
  let activityRoute: ParamRoute<{ companyId: string }>;
  let decisionRoomRoute: ParamRoute<{ companyId: string }>;
  let decisionRoomStreamRoute: ParamRoute<{ companyId: string }>;
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
    // Owned by the harness (`configureRouteRuntimeEnv`) so this suite, the Slice A suite and the demo script
    // cannot drift apart: it points the composition at the CI database using the RESTRICTED role with
    // synthetic (never real) Clerk configuration, and DELETES DATABASE_URL so the owner connection string is
    // not even present in the environment the routes run under.
    configureRouteRuntimeEnv();

    companiesRoute = await import('../../app/api/companies/route.js');
    companyRoute = await import('../../app/api/companies/[companyId]/route.js');
    pauseRoute = await import('../../app/api/companies/[companyId]/pause/route.js');
    activityRoute = await import('../../app/api/companies/[companyId]/activity/route.js');
    decisionRoomRoute = await import('../../app/api/companies/[companyId]/decision-room/route.js');
    decisionRoomStreamRoute = await import('../../app/api/companies/[companyId]/decision-room/stream/route.js');
    provisioningRoute = await import('../../app/api/companies/[companyId]/provisioning/route.js');
    adminReadRoute = await import('../../app/api/admin/accounts/[accountId]/companies/[companyId]/read/route.js');
  }, 90_000);
  afterAll(async () => {
    await teardown(owner, product);
  });
  beforeEach(async () => {
    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product, CORE_SEED_OPS);
    setForgedClaims({ accountId: w.accountA, companyId: w.companyA1 }); // claims name the REAL target
  });

  test('the route runtime itself connects as acbp_app (not the owner role)', async () => {
    // The suite's own `product` client is guarded in beforeAll, but the ROUTES use the production
    // composition root's client. Without this probe, a regression that let the runtime fall back to
    // DATABASE_URL would run every assertion below as a BYPASSRLS superuser — and they would all still
    // pass, because the denials would come from application logic with RLS silently absent.
    await signInAs(w.aOwner);
    const res = await companyRoute.GET(new Request(`https://app.test/api/companies/${w.companyA1}`), { params: Promise.resolve({ companyId: w.companyA1 }) });
    expect(res.status, 'precondition: the runtime must be able to serve a legitimate request').toBe(200);
    const runtimeBackends = await runtimeConnectionRoles(owner, ['acbp-adversarial-fixture', 'acbp-adversarial-app']);
    expect(runtimeBackends.length, 'the runtime must hold at least one connection after serving a request').toBeGreaterThan(0);
    expect(runtimeBackends.every((b) => b.role === 'acbp_app'), `route runtime connected as ${runtimeBackends.map((b) => b.role).join(',')}`).toBe(true);
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

  test('[AUTHZ-FORGED-CLERK-ROLE] a REAL member with a forged owner role cannot perform an owner-only mutation (the sharp #20 case)', async () => {
    // aViewer is a GENUINE active member of account A and of company A1 — but the company routes resolve the
    // caller's OWN personal account (ADR-022 flow), so account A is not his request scope. His Backend User
    // claims `accountId: accountA`, `companyId: companyA1` and `role: 'owner'` — i.e. exactly the values that
    // would redirect the request into account A if any of them were trusted. None may be.
    await signInAs(w.aViewer);
    const before = new Map((await owner.kysely.selectFrom('companies').select(['id', 'status']).execute()).map((r) => [r.id, r.status]));

    const paused = await pauseRoute.POST(jsonRequest(`https://app.test/api/companies/${w.companyA1}/pause`), { params: Promise.resolve({ companyId: w.companyA1 }) });
    expect([403, 404], 'a forged accountId/role must not reach account A’s company').toContain(paused.status);
    const detail = await companyRoute.GET(new Request(`https://app.test/api/companies/${w.companyA1}`), { params: Promise.resolve({ companyId: w.companyA1 }) });
    expect([403, 404], 'a forged accountId must not redirect the read into account A').toContain(detail.status);
    expect(await detail.text()).not.toContain('Alpha One');

    // Nothing in the database moved — every company holds the status it had before.
    const after = new Map((await owner.kysely.selectFrom('companies').select(['id', 'status']).execute()).map((r) => [r.id, r.status]));
    for (const [id, status] of before) expect(after.get(id), `company ${id} changed status`).toBe(status);
  });

  test('[AUTHZ-FORGED-CLERK-ROLE] SOURCE GUARD: no production file reads provider metadata or organization claims', () => {
    // The runtime proof above can only fail if some production code READS these fields. This guard makes the
    // absence structural: browser-controlled claim surfaces must never be referenced outside tests.
    const offenders: string[] = [];
    const forbidden = [/publicMetadata/, /privateMetadata/, /unsafeMetadata/, /organizationMemberships/, /\borgId\b/, /\borgRole\b/, /\borg_role\b/];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (['node_modules', '.next', 'dist', 'adversarial'].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        const code = readFileSync(full, 'utf8')
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .map((line) => line.replace(/\/\/.*/, ''))
          .join('\n')
          .replace(/\/\*[\s\S]*?\*\//g, '');
        if (forbidden.some((p) => p.test(code))) offenders.push(full);
      }
    };
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
    for (const dir of ['apps/web/src', 'packages/core/src', 'packages/adapters/src', 'packages/contracts/src']) walk(join(repoRoot, ...dir.split('/')));
    expect(offenders, 'production code began reading browser-controlled provider claims').toEqual([]);
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
        await decisionRoomRoute.GET(new Request(`https://app.test/api/companies/${companyId}/decision-room`), { params: Promise.resolve({ companyId }) }),
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
    // Account B's statuses are exactly what the fixture set them to (B1 active, B2 deliberately paused) —
    // asserting "nothing is paused" would be wrong now that B2 is paused by design.
    const statuses = new Map((await owner.kysely.selectFrom('companies').select(['id', 'status']).where('account_id', '=', w.accountB).execute()).map((r) => [r.id, r.status]));
    expect(statuses.get(w.companyB1), 'B1 must be untouched by the IDOR attempts').toBe('active');
    expect(statuses.get(w.companyB2), 'B2 must remain in its fixture state').toBe('paused');
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
      await decisionRoomRoute.GET(new Request(`https://app.test/api/companies/${w.companyA1}/decision-room`), { params: Promise.resolve({ companyId: w.companyA1 }) }),
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

  // ── ACBP-P6-008: the Decision Room and its live channel ────────────────────────────────────────────
  test('[SCOPE-SELECTOR-HARVESTED] the LIVE CHANNEL never opens for a caller who may not read the room', async () => {
    // The dangerous shape for a stream is "200 text/event-stream, then close": to a browser that is a network
    // blip, so a client retries forever and a denial is never surfaced. An unauthorized caller must get the
    // ORDINARY JSON denial instead, and no stream body at all.
    for (const [user, companyId] of [
      [w.outsider, w.companyA1],
      [w.bOwner, w.companyA1],
      [w.platformAdmin, w.companyA1],
    ] as const) {
      await signInAs(user);
      const res = await decisionRoomStreamRoute.GET(new Request(`https://app.test/api/companies/${companyId}/decision-room/stream`), { params: Promise.resolve({ companyId }) });
      expect([401, 403, 404], `${user} must not open a stream`).toContain(res.status);
      expect(res.headers.get('content-type') ?? '', 'a denied caller must not receive an event stream').not.toContain('text/event-stream');
      const text = await res.text();
      expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).toEqual(['error']);
      expect(text).not.toContain('Alpha One');
    }
  });

  test('a member gets the whole room — ten sections, and the stream opens and carries NO item payload', async () => {
    await signInAs(w.aOwner);
    const res = await decisionRoomRoute.GET(new Request(`https://app.test/api/companies/${w.companyA1}/decision-room`), { params: Promise.resolve({ companyId: w.companyA1 }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { room: { sections: { queue: string; status: string }[]; integrity: unknown; digest: string } };
    expect(body.room.sections).toHaveLength(10);
    expect(body.room.sections.every((s) => s.status !== 'unavailable'), 'a healthy read must not degrade any section').toBe(true);

    const stream = await decisionRoomStreamRoute.GET(new Request(`https://app.test/api/companies/${w.companyA1}/decision-room/stream?intervalMs=2000`), {
      params: Promise.resolve({ companyId: w.companyA1 }),
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    try {
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('event: room');
      expect(first).toContain('"deliveryMode":"poll_backed"');
      expect(first, 'the wire carries counts, never queue payloads').not.toContain('"items"');
      expect(first).not.toContain('Alpha One');
    } finally {
      await reader.cancel();
    }
  });

  test('the room refuses a query surface: a caller cannot ask for a subset that looks like a whole room', async () => {
    await signInAs(w.aOwner);
    for (const qs of ['?queue=results', '?limit=1', `?companyId=${w.companyB1}`]) {
      const res = await decisionRoomRoute.GET(new Request(`https://app.test/api/companies/${w.companyA1}/decision-room${qs}`), { params: Promise.resolve({ companyId: w.companyA1 }) });
      expect(res.status, `query '${qs}' must be rejected outright`).toBe(400);
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
