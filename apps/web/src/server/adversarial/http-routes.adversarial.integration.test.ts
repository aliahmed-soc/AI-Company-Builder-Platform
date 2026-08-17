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
  // ACBP-API-010 — model-free builders for tenant rows behind a multi-table constraint chain, so the three
  // CDR-088 blocks below can prove a foreign row that PROVABLY EXISTS is still invisible.
  seedForeignRoadmap,
  seedForeignArtifact,
  seedForeignApprovalRequest,
  type TwoTenantWorld,
  type AdversarialDatabaseClient,
  type SeededRoadmap,
  type SeededArtifact,
  type SeededApprovalRequest,
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

  /**
   * CDR-089 §4 — the two run reads join this matrix (ACBP-API-003).
   *
   * THIS BLOCK SEEDS, AND SO IT MAKES THE STRONGER CLAIM. `task_runs` seeds from a task and tasks seed
   * standalone, so a foreign run PROVABLY EXISTS here and is still invisible. CDR-089 §4 committed it to that
   * stronger form before any of it was written.
   *
   * IT IS NO LONGER THE ONLY BLOCK THAT DOES. This header used to add that the roadmap, artifact and approvals
   * blocks "could only prove refusal at company scope — their tables need decision/run chains — and they say
   * so." All three seed as of ACBP-API-010 / CDR-093, and for two of them the stated chain was never real: they
   * cited an FK to a `runs` table that does not exist, when the constraint is a composite onto the very
   * `task_runs` this block has been seeding all along. The sentence is removed rather than softened, because a
   * comparative claim about a sibling block is exactly the kind that goes stale silently when the sibling
   * changes.
   *
   * `failure_category` is applied by UPDATE, never at insert: its insert type is `never`, because a run cannot
   * be BORN failed — it has to fail. The compiler caught that in the core suite and the same rule holds here.
   */
  describe('CDR-089 — run reads', () => {
    let runRoute: ParamRoute<{ companyId: string; runId: string }>;
    let taskRunsRoute: ParamRoute<{ companyId: string; taskId: string }>;
    let taskInA = '';
    let runInB = '';

    beforeAll(async () => {
      runRoute = await import('../../app/api/companies/[companyId]/runs/[runId]/route.js');
      taskRunsRoute = await import('../../app/api/companies/[companyId]/tasks/[taskId]/runs/route.js');
    });

    beforeEach(async () => {
      // Nested, because the parent suite truncates before EVERY test (§4.1). A run seeded in `beforeAll` would
      // be gone before the first assertion — the trap that cost slice 1 three CI cycles.
      const a = await owner.kysely
        .insertInto('tasks')
        .values({ account_id: w.accountA, company_id: w.companyA1, title: 'A task', created_by_user_id: w.aOwner })
        .returning('id')
        .executeTakeFirstOrThrow();
      taskInA = a.id;
      const bTask = await owner.kysely
        .insertInto('tasks')
        .values({ account_id: w.accountB, company_id: w.companyB1, title: 'B task', created_by_user_id: w.bOwner })
        .returning('id')
        .executeTakeFirstOrThrow();
      const bRun = await owner.kysely
        .insertInto('task_runs')
        .values({ account_id: w.accountB, company_id: w.companyB1, task_id: bTask.id, attempt: 1, state: 'failed' })
        .returning('id')
        .executeTakeFirstOrThrow();
      runInB = bRun.id;
      expect(runInB, 'fixture guard: the foreign run must exist before any negative runs').toBeTruthy();
    });

    const getRun = async (companyId: string, runId: string): Promise<{ status: number; body: string }> => {
      const res = await runRoute.GET(new Request(`https://app.test/api/companies/${companyId}/runs/${runId}`), { params: Promise.resolve({ companyId, runId }) });
      return { status: res.status, body: await res.text() };
    };
    const listRuns = async (companyId: string, taskId: string): Promise<{ status: number; body: string }> => {
      const res = await taskRunsRoute.GET(new Request(`https://app.test/api/companies/${companyId}/tasks/${taskId}/runs`), { params: Promise.resolve({ companyId, taskId }) });
      return { status: res.status, body: await res.text() };
    };

    test('G-cross — B\'s run is unreachable via B AND when its id is smuggled into A', async () => {
      await signInAs(w.aOwner);
      expect((await getRun(w.companyB1, runInB)).status, 'read into B').not.toBe(200);
      // The sub-resource attack: a company the caller DOES hold, but a run id belonging to another one.
      const smuggled = await getRun(w.companyA1, runInB);
      expect(smuggled.status, "B's run id smuggled into A").not.toBe(200);
      expect(smuggled.body, 'must not leak the foreign run id').not.toContain(runInB);
    });

    test('G-oracle(a) — COMPANY granularity: foreign vs unknown, byte-identical on both routes', async () => {
      await signInAs(w.aOwner);
      for (const [name, call] of [
        ['run detail', (id: string) => getRun(id, runInB)],
        ['task runs', (id: string) => listRuns(id, taskInA)],
      ] as const) {
        const foreign = await call(w.companyB1);
        const unknown = await call(UNKNOWN_UUID);
        expect(foreign.status, `${name}: identical status`).toBe(unknown.status);
        expect(foreign.body, `${name}: identical body`).toBe(unknown.body);
      }
    });

    test('G-oracle(b) — RUN granularity: a FOREIGN run id and an UNKNOWN one are byte-identical', async () => {
      // Inside company A, which this caller legitimately holds, so the only variable is the sub-resource id.
      await signInAs(w.aOwner);
      const foreign = await getRun(w.companyA1, runInB);
      const unknown = await getRun(w.companyA1, UNKNOWN_UUID);
      expect(foreign.status, 'identical status').toBe(unknown.status);
      expect(foreign.body, 'identical body').toBe(unknown.body);
    });

    test('CDR-089 §3 — an UNKNOWN task and a task with NO RUNS agree, at the HTTP boundary too', async () => {
      // The core suite pins this at the use-case level; this pins it at the wire, where a future route edit could
      // reintroduce a 404 without touching core. Both must stay 200 with an empty list.
      await signInAs(w.aOwner);
      const empty = await listRuns(w.companyA1, taskInA);
      const unknown = await listRuns(w.companyA1, UNKNOWN_UUID);
      expect(empty.status).toBe(200);
      expect(empty.body).toBe(unknown.body);
    });

    test('G-malformed — a malformed id in EITHER position never succeeds and never leaks', async () => {
      await signInAs(w.aOwner);
      for (const bad of MALFORMED) {
        for (const [name, res] of [
          ['runId', await getRun(w.companyA1, bad)],
          ['companyId (run)', await getRun(bad, runInB)],
          ['taskId', await listRuns(w.companyA1, bad)],
        ] as const) {
          expect(res.status, `${name} '${bad}' must not succeed`).not.toBe(200);
          expect(Object.keys(JSON.parse(res.body) as Record<string, unknown>), `${name} '${bad}' bounded envelope`).toEqual(['error']);
          for (const leak of ['select', 'insert', 'constraint', 'pg_', 'stack', 'task_runs', w.companyB1, runInB]) {
            expect(res.body.toLowerCase(), `${name} '${bad}' must not leak '${leak}'`).not.toContain(String(leak).toLowerCase());
          }
        }
      }
    });

    test('the DTO ALLOWLIST holds at the wire: no tenant id reaches a served run', async () => {
      // The unit test proves the mapper on a literal row; the core suite proves it on a real row. This proves it
      // through the ROUTE, so a future edit that bypassed the mapper would still be caught here.
      await signInAs(w.aOwner);
      const own = await owner.kysely
        .insertInto('task_runs')
        .values({ account_id: w.accountA, company_id: w.companyA1, task_id: taskInA, attempt: 1, state: 'succeeded' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const res = await getRun(w.companyA1, own.id);
      expect(res.status, 'the caller can read their own run').toBe(200);
      for (const secret of [w.accountA, w.companyA1]) {
        expect(res.body, `${secret} is internal scoping and must not reach the wire`).not.toContain(secret);
      }
    });
  });

  /**
   * CDR-088 §4 — the roadmap edit joins this matrix. THE ONLY SLICE-2 ROUTE THAT WRITES.
   *
   * That changes what the matrix must assert. For the six read routes, a status code is the whole surface: there
   * is nothing to persist, so "it refused" and "it changed nothing" are the same claim. Here they are NOT. A
   * refusal that still wrote a roadmap row would satisfy every status assertion below and be exactly the defect
   * worth catching, so the negative is taken FROM THE DATABASE.
   *
   * THE ASSERTION IS THAT THE SET OF ROADMAP IDS IS IDENTICAL before and after the refused writes. A
   * cross-company edit that leaked through would have to create a row to succeed, and a created row changes
   * that set.
   *
   * IT NOW RUNS AGAINST A NON-EMPTY BASELINE (ACBP-API-010). This header used to say the block "works without
   * seeding, which is why it makes a stronger claim than the roadmap READ block despite the same inability to
   * seed a roadmap (the decision chain)", and that an empty table was "a perfectly good baseline for nothing
   * was created". Both sentences are gone: the inability was never real — `seedForeignRoadmap` builds the
   * chain — and an empty baseline is the weaker one, because a set that starts empty and ends empty is also
   * what a route that can never write anything produces. Seeding company B means the baseline contains a real
   * foreign roadmap that the refused edit must leave EXACTLY as it found it.
   */
  describe('CDR-088 — roadmap edit (the only slice-2 write)', () => {
    let editRoute: ParamPostRoute<{ companyId: string }>;
    let editForeignRoadmap: SeededRoadmap;

    beforeAll(async () => {
      editRoute = await import('../../app/api/companies/[companyId]/roadmap/edit/route.js');
    });

    beforeEach(async () => {
      // Nested (§4.1) — the parent truncates before every test. Only company B is seeded here: the point is a
      // real foreign roadmap in the baseline, and giving company A one too would change which edits are
      // legitimately addressable and is a different test.
      editForeignRoadmap = await seedForeignRoadmap(owner, { accountId: w.accountB, companyId: w.companyB1, userId: w.bOwner, marker: 'FOREIGN-EDIT-ROADMAP-DO-NOT-LEAK' });
      const seeded = await owner.kysely.selectFrom('roadmaps').select(['id', 'company_id']).where('company_id', '=', w.companyB1).execute();
      expect(seeded.map((r) => r.id), "fixture guard: B's roadmap must EXIST so the baseline is not empty").toContain(editForeignRoadmap.roadmapId);
    });

    const postEdit = async (companyId: string, expectedRoadmapId: string): Promise<{ status: number; body: string }> => {
      const res = await editRoute.POST(
        new Request(`https://app.test/api/companies/${companyId}/roadmap/edit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedRoadmapId, plan: '{"goals":[]}', reason: 'adversarial probe' }),
        }),
        { params: Promise.resolve({ companyId }) },
      );
      return { status: res.status, body: await res.text() };
    };

    test('G-cross — a member of A cannot edit company B, and NO ROADMAP ROW MOVES', async () => {
      await signInAs(w.aOwner);
      const before = (await owner.kysely.selectFrom('roadmaps').select('id').execute()).map((r) => r.id).sort();

      expect((await postEdit(w.companyB1, UNKNOWN_UUID)).status, 'edit into B').not.toBe(200);
      expect((await postEdit(UNKNOWN_UUID, UNKNOWN_UUID)).status, 'edit into an unknown company').not.toBe(200);

      // THE DATABASE IS THE ASSERTION. A refusal that still wrote would pass both checks above; only this one
      // distinguishes "refused" from "refused, but changed something anyway".
      const after = (await owner.kysely.selectFrom('roadmaps').select('id').execute()).map((r) => r.id).sort();
      expect(after, 'no roadmap row may be created by a refused edit').toEqual(before);
    });

    test('G-oracle — a FOREIGN company id and an UNKNOWN one are byte-identical', async () => {
      await signInAs(w.aOwner);
      const foreign = await postEdit(w.companyB1, UNKNOWN_UUID);
      const unknown = await postEdit(UNKNOWN_UUID, UNKNOWN_UUID);
      expect(foreign.status, 'identical status').toBe(unknown.status);
      expect(foreign.body, 'identical body').toBe(unknown.body);
    });

    test('G-malformed — a malformed company id never succeeds, never leaks, and writes nothing', async () => {
      await signInAs(w.aOwner);
      const before = (await owner.kysely.selectFrom('roadmaps').select('id').execute()).length;
      for (const bad of MALFORMED) {
        const res = await postEdit(bad, UNKNOWN_UUID);
        expect(res.status, `'${bad}' must not succeed`).not.toBe(200);
        expect(Object.keys(JSON.parse(res.body) as Record<string, unknown>), `'${bad}' bounded envelope`).toEqual(['error']);
        for (const leak of ['select', 'insert', 'constraint', 'pg_', 'stack', 'roadmaps_', w.companyB1]) {
          expect(res.body.toLowerCase(), `'${bad}' must not leak '${leak}'`).not.toContain(String(leak).toLowerCase());
        }
      }
      expect((await owner.kysely.selectFrom('roadmaps').select('id').execute()).length, 'a malformed edit writes nothing').toBe(before);
    });

    test('a malformed BODY is refused before the domain, and writes nothing', async () => {
      await signInAs(w.aOwner);
      const before = (await owner.kysely.selectFrom('roadmaps').select('id').execute()).length;
      const res = await editRoute.POST(
        new Request(`https://app.test/api/companies/${w.companyA1}/roadmap/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json at all' }),
        { params: Promise.resolve({ companyId: w.companyA1 }) },
      );
      expect(res.status).toBe(400);
      expect((await owner.kysely.selectFrom('roadmaps').select('id').execute()).length, 'an unparseable body writes nothing').toBe(before);
    });
  });

  /**
   * CDR-088 §4 — the approvals inbox joins this matrix.
   *
   * THIS BLOCK NOW SEEDS REAL APPROVAL REQUESTS IN BOTH TENANTS (ACBP-API-010), AND ITS OLD DISCLOSURE CARRIED
   * THE SAME FACTUAL ERROR THE ARTIFACT BLOCK DID. It used to read: *"NO APPROVAL REQUEST IS SEEDED.
   * `approval_requests.run_id` is NOT NULL with an FK to `runs`, so a real row needs the run chain."* There is no
   * `runs` table; `approval_requests_run_fk` is a tenant-pinned composite onto **`task_runs`** (migration 0047).
   * The comment also omitted the one hop that genuinely is extra here: `approval_requests_policy_fk` is a
   * three-column composite `(policy_id, policy_version, company_id) → policies`, both policy columns NOT NULL, so
   * an approval request cannot exist without a policy in the SAME company. `policy_eval_id` is nullable, so no
   * `policy_evaluations` row is required — four inserts, not five. `seedForeignApprovalRequest` owns them.
   *
   * WHY BOTH TENANTS ARE SEEDED, AND NOT JUST THE FOREIGN ONE. The old comment was explicit that the raw-column
   * check at the bottom of this block was *"VACUOUS while the inbox is empty"* and *"earns its place only if this
   * block ever seeds"*. Seeding only company B would have proven invisibility while leaving that test exactly as
   * vacuous as it was. A request is therefore planted in company A as well, the caller's own inbox is asserted
   * NON-EMPTY, and only then is the served body checked for raw column names — so the tripwire is now firing
   * against a real row rather than against an empty list.
   *
   * WHERE THE ALLOWLIST IS STILL ACTUALLY PROVEN: in the UNIT test, which feeds a row carrying a sentinel in
   * every excluded column and asserts the item has exactly the eleven allowlisted keys. THAT remains the real
   * control, and this HTTP check remains the weaker second line of defence. What changed is that the second line
   * is no longer decorative.
   */
  describe('CDR-088 — approvals inbox', () => {
    let approvalsRoute: ParamRoute<{ companyId: string }>;
    const FOREIGN_APPROVAL_MARKER = 'FOREIGN-APPROVAL-DO-NOT-LEAK';
    const OWN_APPROVAL_MARKER = 'OWN-APPROVAL-MUST-BE-VISIBLE';
    let foreignApproval: SeededApprovalRequest;
    let ownApproval: SeededApprovalRequest;

    beforeAll(async () => {
      approvalsRoute = await import('../../app/api/companies/[companyId]/approvals/route.js');
    });

    beforeEach(async () => {
      foreignApproval = await seedForeignApprovalRequest(owner, { accountId: w.accountB, companyId: w.companyB1, userId: w.bOwner, marker: FOREIGN_APPROVAL_MARKER });
      ownApproval = await seedForeignApprovalRequest(owner, { accountId: w.accountA, companyId: w.companyA1, userId: w.aOwner, marker: OWN_APPROVAL_MARKER });
      // Existence first, on the OWNER connection, pinned to the ids the fixtures claim.
      const seeded = await owner.kysely.selectFrom('approval_requests').select(['id', 'company_id']).execute();
      expect(seeded.filter((r) => r.company_id === w.companyB1).map((r) => r.id), "fixture guard: B's approval request must EXIST before any invisibility claim").toContain(foreignApproval.requestId);
      expect(seeded.filter((r) => r.company_id === w.companyA1).map((r) => r.id), "fixture guard: A's own approval request must EXIST or the raw-column check stays vacuous").toContain(ownApproval.requestId);
    });

    const getApprovals = async (companyId: string): Promise<{ status: number; body: string }> => {
      const res = await approvalsRoute.GET(new Request(`https://app.test/api/companies/${companyId}/approvals`), { params: Promise.resolve({ companyId }) });
      return { status: res.status, body: await res.text() };
    };

    test("G-cross — B's approval request PROVABLY EXISTS and is still invisible to A", async () => {
      await signInAs(w.aOwner);
      expect((await getApprovals(w.companyB1)).status, 'read into B').not.toBe(200);

      // The stronger claim, and the reason this block now seeds: A's OWN inbox is a 200 that must carry A's
      // request and none of B's. Asserting the own row is present first means a mapper that returned an empty
      // list for everyone could not pass this test by accident.
      const own = await getApprovals(w.companyA1);
      expect(own.status, 'A reading its own inbox').toBe(200);
      expect(own.body, "A's own inbox must contain A's own request").toContain(OWN_APPROVAL_MARKER);
      expect(own.body, "A's own inbox must not contain B's preview").not.toContain(FOREIGN_APPROVAL_MARKER);
      expect(own.body, "A's own inbox must not contain B's request id").not.toContain(foreignApproval.requestId);
      expect(own.body, "A's own inbox must not contain B's run id").not.toContain(foreignApproval.runId);
    });

    test('G-oracle — a FOREIGN company id and an UNKNOWN one are byte-identical', async () => {
      await signInAs(w.aOwner);
      const foreign = await getApprovals(w.companyB1);
      const unknown = await getApprovals(UNKNOWN_UUID);
      expect(foreign.status, 'identical status').toBe(unknown.status);
      expect(foreign.body, 'identical body').toBe(unknown.body);
    });

    test('G-malformed — a malformed id never succeeds and never leaks', async () => {
      await signInAs(w.aOwner);
      for (const bad of MALFORMED) {
        const res = await getApprovals(bad);
        expect(res.status, `'${bad}' must not succeed`).not.toBe(200);
        expect(Object.keys(JSON.parse(res.body) as Record<string, unknown>), `'${bad}' bounded envelope`).toEqual(['error']);
        for (const leak of ['select', 'insert', 'constraint', 'pg_', 'stack', 'approval_requests', w.companyB1, foreignApproval.requestId, FOREIGN_APPROVAL_MARKER]) {
          expect(res.body.toLowerCase(), `'${bad}' must not leak '${leak}'`).not.toContain(String(leak).toLowerCase());
        }
      }
    });

    test('no RAW COLUMN NAME ever appears in a served inbox — now against a REAL row', async () => {
      await signInAs(w.aOwner);
      const own = await getApprovals(w.companyA1);
      expect(own.status, 'A reading its own inbox').toBe(200);
      // THE PRECONDITION THAT MAKES THE REST OF THIS TEST MEAN ANYTHING. Until ACBP-API-010 this block seeded
      // nothing, so the loop below ran against an empty list and passed for a reason that had nothing to do with
      // the mapper. Asserting the row actually reached the response first is what converts it from a tripwire
      // into evidence — if the fixture ever stops arriving here, this fails rather than going quietly vacuous.
      expect(own.body, 'the seeded request must actually reach the served inbox').toContain(OWN_APPROVAL_MARKER);
      // snake_case column names are the signature of a raw row escaping the mapper.
      for (const column of ['account_id', 'company_id', 'run_id', 'policy_id', 'policy_version', '"data"']) {
        expect(own.body, `raw column '${column}' must never be served`).not.toContain(column);
      }
    });
  });

  /**
   * CDR-088 §4 — the three artifact reads join this matrix.
   *
   * THIS BLOCK NOW SEEDS A REAL FOREIGN ARTIFACT (ACBP-API-010), AND ITS OLD DISCLOSURE WAS WRONG ON THE FACTS.
   * It used to read: *"NO ARTIFACT IS SEEDED … `artifacts.run_id` is NOT NULL with an FK to `runs`, so a real
   * artifact needs the run chain — the same reason the roadmap block seeds nothing."* **There is no `runs` table
   * in this schema and there never has been.** The tables are `task_runs`, `planning_runs` and `worker_runs`; the
   * actual constraint is `artifacts_run_fk`, a TENANT-PINNED composite `[run_id, company_id] → task_runs[id,
   * company_id]` (migration 0043). `task_runs` needs four columns because `state` defaults, and the CDR-089 block
   * roughly two hundred lines above has been seeding exactly that chain all along.
   *
   * So this matrix was not blocked by a hard constraint. It was blocked by an unverified sentence about one, and
   * it withheld a provable isolation claim on that basis for as long as the sentence stood. The corrected chain is
   * three inserts — `tasks → task_runs → artifacts` — and lives in `seedForeignArtifact`.
   *
   * SEEDING ALSO UNLOCKS A GRANULARITY THIS BLOCK NEVER HAD. With a real artifact in B, the CDR-087 G7(b) oracle
   * applies here: inside company A, which the caller legitimately holds, a FOREIGN artifact id and an UNKNOWN one
   * must be byte-identical. Previously every id in play was unknown, so that distinction could not be posed.
   *
   * THE §2.1a TEST REMAINS THE ONE THAT MATTERS MOST, and it exists at the HTTP level rather than only in the
   * unit tests because `getArtifact` returns `ArtifactDTO | 'forbidden' | 'not_found'`, so a lapse in the adapter
   * would put the literal string `forbidden` into a 200 body AS the artifact. That is a leak-shaped defect no
   * other route in this file can have, and a unit test alone would not catch it if the ROUTE were rewired to
   * bypass the adapter. It now runs with a real artifact present as well.
   */
  describe('CDR-088 — artifact reads', () => {
    let artifactRoute: ParamRoute<{ companyId: string; artifactId: string }>;
    let lineageRoute: ParamRoute<{ companyId: string; artifactId: string }>;
    let runArtifactsRoute: ParamRoute<{ companyId: string; runId: string }>;
    const ARTIFACT_MARKER = 'FOREIGN-ARTIFACT-DO-NOT-LEAK';
    const OWN_ARTIFACT_MARKER = 'OWN-ARTIFACT-MUST-BE-VISIBLE';
    let foreignArtifact: SeededArtifact;
    let ownArtifact: SeededArtifact;

    beforeAll(async () => {
      artifactRoute = await import('../../app/api/companies/[companyId]/artifacts/[artifactId]/route.js');
      lineageRoute = await import('../../app/api/companies/[companyId]/artifacts/[artifactId]/lineage/route.js');
      runArtifactsRoute = await import('../../app/api/companies/[companyId]/runs/[runId]/artifacts/route.js');
    });

    beforeEach(async () => {
      foreignArtifact = await seedForeignArtifact(owner, { accountId: w.accountB, companyId: w.companyB1, userId: w.bOwner, marker: ARTIFACT_MARKER });
      // The positive control, for the same reason the roadmap block seeds one: with no artifact anywhere in A,
      // "B's artifact never appears in A" is satisfied by a read that returns nothing to anyone.
      ownArtifact = await seedForeignArtifact(owner, { accountId: w.accountA, companyId: w.companyA1, userId: w.aOwner, marker: OWN_ARTIFACT_MARKER });
      // Existence first, on the OWNER connection, pinned to the ids the fixtures claim — see the roadmap block.
      const seeded = await owner.kysely.selectFrom('artifacts').select(['id', 'company_id']).execute();
      expect(seeded.filter((r) => r.company_id === w.companyB1).map((r) => r.id), "fixture guard: B's artifact must EXIST before any invisibility claim").toContain(foreignArtifact.artifactId);
      expect(seeded.filter((r) => r.company_id === w.companyA1).map((r) => r.id), "fixture guard: A's own artifact must EXIST or the negatives are vacuous").toContain(ownArtifact.artifactId);
    });

    /** `runId` defaults to `id` so the pre-existing unknown-id calls are unchanged; the seeded cases pass both. */
    const callAll = async (companyId: string, id: string, runId: string = id): Promise<ReadonlyArray<{ name: string; status: number; body: string }>> => {
      const out: Array<{ name: string; status: number; body: string }> = [];
      for (const [name, route, key] of [
        ['artifact', artifactRoute, 'artifactId'],
        ['lineage', lineageRoute, 'artifactId'],
        ['runArtifacts', runArtifactsRoute, 'runId'],
      ] as const) {
        const value = key === 'runId' ? runId : id;
        const url = key === 'runId' ? `https://app.test/api/companies/${companyId}/runs/${value}/artifacts` : `https://app.test/api/companies/${companyId}/artifacts/${value}`;
        const res = await (route as ParamRoute<Record<string, string>>).GET(new Request(url), { params: Promise.resolve({ companyId, [key]: value }) });
        out.push({ name, status: res.status, body: await res.text() });
      }
      return out;
    };

    test('G-cross — a member of A cannot reach company B through any of the three', async () => {
      await signInAs(w.aOwner);
      for (const r of await callAll(w.companyB1, UNKNOWN_UUID)) {
        expect(r.status, `${r.name}: read into B`).not.toBe(200);
      }
    });

    test('the caller CAN read an artifact in their own company — ALL THREE routes, the positive that makes the negatives meaningful', async () => {
      // Without this, every "B's artifact does not appear" assertion below would be satisfied just as well by
      // a route that serves no artifact to anybody. This proves the reads work before they are asked to refuse.
      //
      // IT COVERS ALL THREE ROUTES ON PURPOSE, and an earlier version of this test did not. It asserted only
      // `artifact` and `runArtifacts` while `callAll` drives THREE, so every lineage negative in this block was
      // still satisfied by a lineage route that served nothing to anybody — the exact vacuity this block exists
      // to close, left open on one route. The relocation mutation could not reveal it either: `artifact` is
      // index 0 in `callAll`, so its assertion throws before lineage is ever examined. Partial coverage of a
      // multi-route helper is the failure mode; assert every route the helper drives.
      await signInAs(w.aOwner);
      const own = await callAll(w.companyA1, ownArtifact.artifactId, ownArtifact.runId);
      for (const name of ['artifact', 'lineage', 'runArtifacts'] as const) {
        const r = own.find((x) => x.name === name);
        expect(r?.status, `A reading its OWN artifact via '${name}'`).toBe(200);
        expect(r?.body, `'${name}' must actually serve A's own artifact`).toContain(ownArtifact.title);
      }
    });

    test("G-cross(seeded) — B's artifact PROVABLY EXISTS and never appears, in B or smuggled into A", async () => {
      await signInAs(w.aOwner);
      // Addressed in its own company, by its real ids: still refused.
      for (const r of await callAll(w.companyB1, foreignArtifact.artifactId, foreignArtifact.runId)) {
        expect(r.status, `${r.name}: B's real artifact read into B`).not.toBe(200);
        expect(r.body, `${r.name}: must not leak the artifact title`).not.toContain(foreignArtifact.title);
      }
      // The sub-resource attack: a company the caller genuinely holds, carrying another company's ids. The
      // run-artifacts route answers 200 with an empty list for an unknown run by design (§2.1a), so a status
      // check alone would not catch a leak here — the body assertion is the one doing the work.
      for (const r of await callAll(w.companyA1, foreignArtifact.artifactId, foreignArtifact.runId)) {
        expect(r.body, `${r.name}: B's artifact must not surface inside A`).not.toContain(foreignArtifact.title);
        expect(r.body, `${r.name}: B's artifact id must not surface inside A`).not.toContain(foreignArtifact.artifactId);
      }
    });

    test('G-oracle(b) — ARTIFACT granularity: a FOREIGN artifact id and an UNKNOWN one are byte-identical', async () => {
      // Inside company A, which this caller legitimately holds, so the ONLY variable is the sub-resource id.
      // This check is only posable because a foreign artifact now exists to name.
      await signInAs(w.aOwner);
      const foreign = await callAll(w.companyA1, foreignArtifact.artifactId, foreignArtifact.runId);
      const unknown = await callAll(w.companyA1, UNKNOWN_UUID, UNKNOWN_UUID);
      for (let i = 0; i < foreign.length; i += 1) {
        expect(foreign[i]?.status, `${foreign[i]?.name}: identical status`).toBe(unknown[i]?.status);
        expect(foreign[i]?.body, `${foreign[i]?.name}: identical body`).toBe(unknown[i]?.body);
      }
    });

    test('G-oracle — a FOREIGN company id and an UNKNOWN one are byte-identical on all three', async () => {
      await signInAs(w.aOwner);
      const foreign = await callAll(w.companyB1, UNKNOWN_UUID);
      const unknown = await callAll(UNKNOWN_UUID, UNKNOWN_UUID);
      for (let i = 0; i < foreign.length; i += 1) {
        expect(foreign[i]?.status, `${foreign[i]?.name}: identical status`).toBe(unknown[i]?.status);
        expect(foreign[i]?.body, `${foreign[i]?.name}: identical body`).toBe(unknown[i]?.body);
      }
    });

    test('G-malformed — a malformed id never succeeds and never leaks', async () => {
      await signInAs(w.aOwner);
      for (const bad of MALFORMED) {
        for (const r of await callAll(w.companyA1, bad)) {
          expect(r.status, `${r.name} '${bad}' must not succeed`).not.toBe(200);
          expect(Object.keys(JSON.parse(r.body) as Record<string, unknown>), `${r.name} '${bad}' bounded envelope`).toEqual(['error']);
          for (const leak of ['select', 'insert', 'constraint', 'pg_', 'stack', 'artifacts_', w.companyB1, foreignArtifact.artifactId, ARTIFACT_MARKER]) {
            expect(r.body.toLowerCase(), `${r.name} '${bad}' must not leak '${leak}'`).not.toContain(String(leak).toLowerCase());
          }
        }
      }
    });

    test('§2.1a — a REFUSAL STRING is never served as a 200 payload', async () => {
      // The defect this guards: `getArtifact` resolving to the literal 'forbidden' and that string being
      // serialized as the artifact. Any 200 here whose payload IS one of those words means the adapter was
      // bypassed. Asserted over every refusal path the matrix can reach.
      await signInAs(w.aOwner);
      const responses = [...(await callAll(w.companyB1, UNKNOWN_UUID)), ...(await callAll(UNKNOWN_UUID, UNKNOWN_UUID)), ...(await callAll(w.companyA1, UNKNOWN_UUID))];
      for (const r of responses) {
        if (r.status !== 200) continue;
        const parsed = JSON.parse(r.body) as Record<string, unknown>;
        for (const key of ['artifact', 'artifacts', 'lineage']) {
          expect(parsed[key], `${r.name}: '${key}' must never be the literal refusal string`).not.toBe('forbidden');
          expect(parsed[key], `${r.name}: '${key}' must never be the literal refusal string`).not.toBe('not_found');
        }
      }
    });
  });

  /**
   * CDR-088 §4 — task detail joins this matrix, and it is the FIRST slice-2 route needing TWO granularities.
   *
   * The roadmap and board reads take only a companyId, so one oracle check covers them. This route takes a
   * SUB-RESOURCE id, and `GetTaskDetailResult` carries a `not_found` arm the other two do not have. So the oracle
   * is asserted TWICE — at company level and at TASK level — because a refusal that is uniform at one level and
   * revealing at the other is still an oracle. This is the CDR-087 G7(b) lesson reaching its first slice-2 case.
   *
   * Both fixtures are seeded on the OWNER connection in a NESTED `beforeEach` (§4.1) and their existence is
   * ASSERTED, so the negatives cannot pass vacuously against an empty table.
   */
  describe('CDR-088 — task detail', () => {
    let detailRoute: ParamRoute<{ companyId: string; taskId: string }>;
    let taskInA = '';
    let taskInB = '';

    beforeAll(async () => {
      detailRoute = await import('../../app/api/companies/[companyId]/tasks/[taskId]/route.js');
    });

    beforeEach(async () => {
      const a = await owner.kysely
        .insertInto('tasks')
        .values({ account_id: w.accountA, company_id: w.companyA1, title: 'TASK-IN-A', created_by_user_id: w.aOwner })
        .returning('id')
        .executeTakeFirstOrThrow();
      const b = await owner.kysely
        .insertInto('tasks')
        .values({ account_id: w.accountB, company_id: w.companyB1, title: 'TASK-IN-B-DO-NOT-LEAK', created_by_user_id: w.bOwner })
        .returning('id')
        .executeTakeFirstOrThrow();
      taskInA = a.id;
      taskInB = b.id;
      expect(taskInA, 'fixture guard: task in A must exist').toBeTruthy();
      expect(taskInB, 'fixture guard: task in B must exist').toBeTruthy();
    });

    const getDetail = async (companyId: string, taskId: string): Promise<{ status: number; body: string }> => {
      const res = await detailRoute.GET(new Request(`https://app.test/api/companies/${companyId}/tasks/${taskId}`), { params: Promise.resolve({ companyId, taskId }) });
      return { status: res.status, body: await res.text() };
    };

    test('the caller CAN read a task in their own company — the positive that makes the negatives meaningful', async () => {
      // Without this, every assertion below would also pass against a route that refused unconditionally.
      await signInAs(w.aOwner);
      const own = await getDetail(w.companyA1, taskInA);
      expect(own.status, 'A reading its own task').toBe(200);
      expect(own.body).toContain('TASK-IN-A');
    });

    test('G-cross — A cannot read B\'s task through B\'s company, nor by citing B\'s task id inside A', async () => {
      await signInAs(w.aOwner);
      const viaB = await getDetail(w.companyB1, taskInB);
      expect(viaB.status, 'read into B').not.toBe(200);
      expect(viaB.body, 'must not leak the foreign title').not.toContain('TASK-IN-B-DO-NOT-LEAK');
      // The sub-resource attack: a company the caller DOES hold, but a task id belonging to another one.
      const smuggled = await getDetail(w.companyA1, taskInB);
      expect(smuggled.status, "B's task id smuggled into A's company").not.toBe(200);
      expect(smuggled.body, 'must not leak the foreign title').not.toContain('TASK-IN-B-DO-NOT-LEAK');
    });

    test('G-oracle(a) — COMPANY granularity: a FOREIGN company id and an UNKNOWN one are byte-identical', async () => {
      await signInAs(w.aOwner);
      const foreign = await getDetail(w.companyB1, taskInB);
      const unknown = await getDetail(UNKNOWN_UUID, taskInB);
      expect(foreign.status, 'identical status').toBe(unknown.status);
      expect(foreign.body, 'identical body').toBe(unknown.body);
    });

    test('G-oracle(b) — TASK granularity: a FOREIGN task id and an UNKNOWN one are byte-identical', async () => {
      // Inside company A, which this caller legitimately holds, so the ONLY variable is the sub-resource id.
      // THIS is the granularity the roadmap and board reads have no analogue for.
      await signInAs(w.aOwner);
      const foreign = await getDetail(w.companyA1, taskInB);
      const unknown = await getDetail(w.companyA1, UNKNOWN_UUID);
      expect(foreign.status, 'identical status').toBe(unknown.status);
      expect(foreign.body, 'identical body').toBe(unknown.body);
    });

    test('G-malformed — a malformed id in EITHER position never succeeds and never leaks', async () => {
      await signInAs(w.aOwner);
      for (const bad of MALFORMED) {
        for (const [where, res] of [
          ['companyId', await getDetail(bad, taskInA)],
          ['taskId', await getDetail(w.companyA1, bad)],
        ] as const) {
          expect(res.status, `${where} '${bad}' must not succeed`).not.toBe(200);
          expect(Object.keys(JSON.parse(res.body) as Record<string, unknown>), `${where} '${bad}' bounded envelope`).toEqual(['error']);
          for (const leak of ['select', 'insert', 'constraint', 'pg_', 'stack', 'tasks_', 'TASK-IN-B-DO-NOT-LEAK', w.companyB1, taskInB]) {
            expect(res.body.toLowerCase(), `${where} '${bad}' must not leak '${leak}'`).not.toContain(String(leak).toLowerCase());
          }
        }
      }
    });
  });

  /**
   * CDR-088 §4 — the task board read joins this matrix.
   *
   * THIS BLOCK SEEDS REAL DATA. `tasks` needs only account_id, company_id, title and created_by_user_id —
   * `milestone_id` is nullable and `state` defaults — so a foreign task PROVABLY EXISTS here and is still
   * invisible.
   *
   * TWO COMPARATIVE CLAIMS WERE REMOVED FROM THIS HEADER, both made false by ACBP-API-010 / CDR-093: that
   * seeding made this block "strictly stronger than the roadmap block below", and that it could prove "the
   * property the roadmap block explicitly cannot". The roadmap block seeds now and proves exactly that
   * property. A comment that ranks itself against a neighbour is a comment that goes stale when the neighbour
   * improves, and nothing fails when it does.
   *
   * The fixture is seeded on the OWNER connection and its existence is ASSERTED before the negative runs. A
   * negative that would pass just as well against an empty table proves nothing, which is the trap three CDR-087
   * tests fell into when the parent `beforeEach` truncated their fixtures away.
   *
   * Seeded in a NESTED `beforeEach` (§4.1) for that same reason — the parent truncates before every test.
   */
  describe('CDR-088 — task board read', () => {
    let tasksRoute: ParamRoute<{ companyId: string }>;
    let foreignTaskTitle = '';
    const ownTaskTitle = 'OWN-TASK-MUST-BE-VISIBLE';

    beforeAll(async () => {
      tasksRoute = await import('../../app/api/companies/[companyId]/tasks/route.js');
    });

    beforeEach(async () => {
      foreignTaskTitle = 'FOREIGN-TASK-DO-NOT-LEAK';
      // `state: 'planned'` IS LOAD-BEARING, and its absence hid a second vacuity (ACBP-API-010). `tasks.state`
      // defaults to 'draft', and DRAFTS ARE DELIBERATELY OFF THE BOARD — `getTaskBoard` counts them only in
      // `draftsOffBoard` and places none of them in a bucket. The foreign task used to be seeded at that
      // default, so "B's task never appears in A's board" was asserted about a task that appears on NOBODY'S
      // board, including its own company's. The negative was true for a reason unrelated to tenant isolation.
      // Both fixtures are now in a state the board actually renders, so the assertion is about visibility.
      await owner.kysely
        .insertInto('tasks')
        .values({ account_id: w.accountB, company_id: w.companyB1, title: foreignTaskTitle, state: 'planned', created_by_user_id: w.bOwner })
        .execute();
      // A task in the CALLER'S OWN company as well. Without it, A's board is empty and "B's task never appears
      // in A's board" is satisfied by a board that returns nothing to anybody.
      await owner.kysely
        .insertInto('tasks')
        .values({ account_id: w.accountA, company_id: w.companyA1, title: ownTaskTitle, state: 'planned', created_by_user_id: w.aOwner })
        .execute();
      // The fixtures must EXIST for the negative below to mean anything. If either returns zero the test must
      // fail here, loudly, rather than pass vacuously downstream.
      const seeded = await owner.kysely.selectFrom('tasks').select(['id', 'company_id']).execute();
      expect(seeded.filter((r) => r.company_id === w.companyB1).length, 'fixture guard: the foreign task must exist before the negative runs').toBeGreaterThan(0);
      expect(seeded.filter((r) => r.company_id === w.companyA1).length, "fixture guard: A's own task must exist or the negative is vacuous").toBeGreaterThan(0);
    });

    const getTasks = async (companyId: string): Promise<{ status: number; body: string }> => {
      const res = await tasksRoute.GET(new Request(`https://app.test/api/companies/${companyId}/tasks`), { params: Promise.resolve({ companyId }) });
      return { status: res.status, body: await res.text() };
    };

    test('G-cross — a member of A cannot reach company B, and B\'s task NEVER appears in any response', async () => {
      await signInAs(w.aOwner);
      expect((await getTasks(w.companyB1)).status, 'read into B').not.toBe(200);
      // POSITIVE CONTROL FIRST: A's own board really does serve A's own task, so the absence asserted below is
      // a real absence rather than an empty response.
      expect((await getTasks(w.companyA1)).body, "positive control: A's own task must actually be served").toContain(ownTaskTitle);
      // The board A legitimately CAN read must not contain B's task either — the stronger claim, and the whole
      // reason this block seeds.
      const own = await getTasks(w.companyA1);
      expect(own.body, "A's own board must not contain B's task").not.toContain(foreignTaskTitle);
    });

    test('G-oracle — a FOREIGN company id and an UNKNOWN one are byte-identical', async () => {
      await signInAs(w.aOwner);
      const foreign = await getTasks(w.companyB1);
      const unknown = await getTasks(UNKNOWN_UUID);
      expect(foreign.status, 'identical status').toBe(unknown.status);
      expect(foreign.body, 'identical body').toBe(unknown.body);
    });

    test('G-malformed — a malformed id never succeeds and never leaks', async () => {
      await signInAs(w.aOwner);
      for (const bad of MALFORMED) {
        const res = await getTasks(bad);
        expect(res.status, `'${bad}' must not succeed`).not.toBe(200);
        expect(Object.keys(JSON.parse(res.body) as Record<string, unknown>), `'${bad}' bounded envelope`).toEqual(['error']);
        for (const leak of ['select', 'insert', 'constraint', 'pg_', 'stack', 'tasks_', foreignTaskTitle, w.companyB1]) {
          expect(res.body.toLowerCase(), `'${bad}' must not leak '${leak}'`).not.toContain(String(leak).toLowerCase());
        }
      }
    });

    test('an unknown query parameter is REFUSED, not ignored', async () => {
      await signInAs(w.aOwner);
      const res = await tasksRoute.GET(new Request(`https://app.test/api/companies/${w.companyA1}/tasks?state=done`), { params: Promise.resolve({ companyId: w.companyA1 }) });
      expect(res.status).toBe(400);
    });
  });

  /**
   * CDR-088 §4 — the roadmap read joins this matrix.
   *
   * THIS BLOCK SEEDS A REAL FOREIGN ROADMAP (ACBP-API-010). It previously did not, and said so honestly: the
   * old comment recorded that `roadmaps.decision_id` is NOT NULL, that a real roadmap therefore needs the whole
   * understanding → generation → selection → decision chain, and that these tests consequently proved refusal
   * AT COMPANY SCOPE but **not** that an existing foreign roadmap stays invisible. That disclosure was accurate
   * — of the three CDR-088 blocks carrying it, this was the only one whose stated blocker was real — and it is
   * now discharged rather than merely restated.
   *
   * THE CHAIN IS BUILT IN `@acbp/test-support`, NOT HERE. `seedForeignRoadmap` owns the seven inserts and every
   * CHECK they have to satisfy, for two reasons: the constraint set is not obvious (three of the seven links
   * carry shape constraints that reject the obvious lazy values), and a chain hand-written inline in one test
   * file is a chain nobody else can reuse or fix in one place. The existing journey helpers were considered
   * first, as the ruling required: `runMvpLoopJourney` does reach a roadmap, but only by driving `generateRoadmap`
   * through a FAKE MODEL GATEWAY with an injected `ops` bundle, neither of which this HTTP suite has.
   *
   * WHAT IS NOW PROVEN, AND WHY THE ORDER OF ASSERTIONS MATTERS. The fixture's existence is asserted on the
   * OWNER connection FIRST, before any refusal is claimed. A negative that runs against an empty table proves
   * nothing — that is the trap three CDR-087 tests fell into when the parent `beforeEach` truncated their
   * fixtures away, and it is why the seeding lives in a NESTED `beforeEach` (§4.1). Only once B's roadmap is
   * known to exist does its invisibility to A mean anything.
   *
   * The byte-identity check is upgraded by the same change. It used to compare two companies that were BOTH
   * empty, where identical bodies were guaranteed for an uninteresting reason. Now the foreign company holds a
   * roadmap and the unknown one cannot, so identical bodies mean the presence of data does not move the answer.
   *
   * There is still NO sub-resource granularity to test: `LatestRoadmapResult` has two arms and no `not_found`,
   * so the CDR-087 G7(b) selection-level oracle has no analogue here.
   */
  describe('CDR-088 — roadmap read', () => {
    let roadmapRoute: ParamRoute<{ companyId: string }>;
    const ROADMAP_MARKER = 'FOREIGN-ROADMAP-DO-NOT-LEAK';
    const OWN_ROADMAP_MARKER = 'OWN-ROADMAP-MUST-BE-VISIBLE';
    let foreignRoadmap: SeededRoadmap;
    let ownRoadmap: SeededRoadmap;

    beforeAll(async () => {
      roadmapRoute = await import('../../app/api/companies/[companyId]/roadmap/route.js');
    });

    beforeEach(async () => {
      foreignRoadmap = await seedForeignRoadmap(owner, { accountId: w.accountB, companyId: w.companyB1, userId: w.bOwner, marker: ROADMAP_MARKER });
      // A ROADMAP IN THE CALLER'S OWN COMPANY TOO, and it is not decoration. Without it, company A has no
      // roadmap at all, so "A's read does not contain B's roadmap" is satisfied by a read that returns null to
      // EVERYONE — a broken route and a correctly isolating one produce the same green. Seeding A gives the
      // positive control that makes the negative mean something, exactly as the task-detail block does.
      ownRoadmap = await seedForeignRoadmap(owner, { accountId: w.accountA, companyId: w.companyA1, userId: w.aOwner, marker: OWN_ROADMAP_MARKER });
      // THE EXISTENCE ASSERTION, AND IT COMES FIRST. Read back through the OWNER connection (which bypasses
      // RLS and so can see B's data) and pinned to the specific id the fixture claims to have created — a
      // bare "some roadmap exists" would still pass if the fixture silently planted it in the wrong company.
      const seeded = await owner.kysely.selectFrom('roadmaps').select(['id', 'company_id']).execute();
      expect(seeded.filter((r) => r.company_id === w.companyB1).map((r) => r.id), "fixture guard: B's roadmap must EXIST before any invisibility claim").toContain(foreignRoadmap.roadmapId);
      expect(seeded.filter((r) => r.company_id === w.companyA1).map((r) => r.id), "fixture guard: A's own roadmap must EXIST or the negative below is vacuous").toContain(ownRoadmap.roadmapId);
    });

    const getRoadmap = async (companyId: string): Promise<{ status: number; body: string }> => {
      const res = await roadmapRoute.GET(new Request(`https://app.test/api/companies/${companyId}/roadmap`), { params: Promise.resolve({ companyId }) });
      return { status: res.status, body: await res.text() };
    };

    test("G-cross — B's roadmap PROVABLY EXISTS and is still invisible to A", async () => {
      await signInAs(w.aOwner);
      expect((await getRoadmap(w.companyB1)).status, 'read into B').not.toBe(200);

      // THE STRONGER CLAIM, and the whole reason this block now seeds. A's own read genuinely RETURNS A's
      // roadmap — that is the positive control — and the same successful response carries no trace of B's.
      const own = await getRoadmap(w.companyA1);
      expect(own.status, 'A reading its own roadmap').toBe(200);
      expect(own.body, "positive control: A's own roadmap must actually be served").toContain(ownRoadmap.roadmapId);
      expect(own.body, "positive control: A's own goal title must actually be served").toContain(ownRoadmap.goalTitle);
      expect(own.body, "A's own roadmap read must not contain B's roadmap id").not.toContain(foreignRoadmap.roadmapId);
      expect(own.body, "A's own roadmap read must not contain B's goal title").not.toContain(foreignRoadmap.goalTitle);
      expect(own.body, "A's own roadmap read must not contain B's decision id").not.toContain(foreignRoadmap.decisionId);
    });

    test('G-oracle — a FOREIGN company id and an UNKNOWN one are byte-identical, WITH the roadmap present', async () => {
      await signInAs(w.aOwner);
      const foreign = await getRoadmap(w.companyB1);
      const unknown = await getRoadmap(UNKNOWN_UUID);
      expect(foreign.status, 'identical status').toBe(unknown.status);
      expect(foreign.body, 'identical body').toBe(unknown.body);
    });

    test('G-malformed — a malformed id never succeeds and never leaks', async () => {
      await signInAs(w.aOwner);
      for (const bad of MALFORMED) {
        const res = await getRoadmap(bad);
        expect(res.status, `'${bad}' must not succeed`).not.toBe(200);
        expect(Object.keys(JSON.parse(res.body) as Record<string, unknown>), `'${bad}' bounded envelope`).toEqual(['error']);
        for (const forbidden of ['select', 'insert', 'constraint', 'pg_', 'stack', 'roadmap_', w.companyB1, foreignRoadmap.roadmapId, ROADMAP_MARKER]) {
          expect(res.body.toLowerCase(), `'${bad}' must not leak '${forbidden}'`).not.toContain(String(forbidden).toLowerCase());
        }
      }
    });

    test('an unknown query parameter is REFUSED, not ignored', async () => {
      // A caller must never believe a filter was applied when it was silently dropped.
      await signInAs(w.aOwner);
      const res = await roadmapRoute.GET(new Request(`https://app.test/api/companies/${w.companyA1}/roadmap?version=2`), { params: Promise.resolve({ companyId: w.companyA1 }) });
      expect(res.status).toBe(400);
    });
  });

  /**
   * CDR-087 §4 — the three strategy/decision routes join this matrix.
   *
   * G7 IS THE REASON THIS BLOCK LOOKS UNUSUAL. Every other route here proves the oracle at ONE granularity: a
   * foreign COMPANY id and an unknown one must be byte-identical. These two POSTs also take a SUB-RESOURCE id
   * (a selection), and `RecordStrategyDecisionResult`/`RecordDecisionResult` carry a `not_found` arm that the
   * company-level routes do not have. So the oracle is asserted TWICE, at both granularities — company and
   * selection — because a refusal that is uniform at one level and revealing at the other is still an oracle.
   *
   * The fixtures are seeded with the OWNER connection, following the precedent in
   * `packages/core/src/strategy/decision-record.integration.test.ts`. That makes the negative STRONGER, not
   * weaker: the foreign row provably exists, and is still invisible to a restricted caller.
   */
  describe('CDR-087 — strategy read and decision recording', () => {
    let strategyRoute: ParamRoute<{ companyId: string }>;
    // ParamRoute requires GET; these two export POST only. A POST-shaped alias is added rather than widening
    // ParamRoute, which would let a GET-less route slip into the GET-based assertions elsewhere in this file.
    type ParamPostRoute<P> = { POST(request: Request, context: { params: Promise<P> }): Promise<Response> };
    let selectionRoute: ParamPostRoute<{ companyId: string }>;
    let decisionsRoute: ParamPostRoute<{ companyId: string }>;
    let genA = '';
    let genB = '';

    /**
     * Seed a generation directly, as the core strategy suites do.
     *
     * THE STATUS IS `fewer_than_three` WITH ZERO OPTIONS, AND THAT IS THE HONEST PAIRING, NOT A SHORTCUT.
     * `strategy_generations_status_count_consistent` (migration 0022) admits only
     * `(complete and option_count >= 3)` or `(fewer_than_three and option_count < 3)`. This fixture seeds no
     * options, so `complete` would be a lie the database correctly refuses — it did, and that is why the first
     * hosted run of this block failed in `beforeAll`.
     *
     * Zero options is sufficient here: nothing in this block reads option content. G4/G7/G6 assert refusal and
     * oracle uniformity, which do not depend on what was generated, and the selection posted below is
     * `mode: 'reject'`, which by CDR-037 selects no option at all.
     */
    async function seedGeneration(accountId: string, companyId: string, actorId: string): Promise<string> {
      const doc = (
        await owner.kysely
          .insertInto('understanding_documents')
          .values({ account_id: accountId, company_id: companyId, version: 1, status: 'complete', overall_confidence: 0.6, created_by_user_id: actorId })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      return (
        await owner.kysely
          .insertInto('strategy_generations')
          .values({ account_id: accountId, company_id: companyId, understanding_document_id: doc, understanding_version: 1, status: 'fewer_than_three', option_count: 0, similarity_check_result: 'distinct', created_by_user_id: actorId })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }

    beforeAll(async () => {
      strategyRoute = await import('../../app/api/companies/[companyId]/strategy/route.js');
      selectionRoute = await import('../../app/api/companies/[companyId]/strategy/selection/route.js');
      decisionsRoute = await import('../../app/api/companies/[companyId]/decisions/route.js');
    });

    /**
     * SEEDED PER TEST, NOT ONCE — the parent suite's `beforeEach` calls `truncateFixtures(owner)` before every
     * test (line 143), so anything seeded in `beforeAll` is gone by the time the first test body runs. A nested
     * `beforeEach` runs AFTER the parent's, which is the only place these rows survive to be used.
     *
     * G7(b) is what exposed this: it is the only one of the four that INSERTS a row referencing a generation, so
     * it failed on `strategy_selections_generation_fk` while the other three passed against generations that
     * silently did not exist. Those passes were still testing company-scope refusal, which is what they assert —
     * but a fixture that is absent when the assertion runs is not a fixture, and the next test added here would
     * have inherited the same trap.
     */
    beforeEach(async () => {
      genA = await seedGeneration(w.accountA, w.companyA1, w.aOwner);
      genB = await seedGeneration(w.accountB, w.companyB1, w.bOwner);
    });

    const surfaceOf = async (res: Response): Promise<{ status: number; body: string }> => ({ status: res.status, body: await res.text() });

    const getStrategy = async (companyId: string): Promise<{ status: number; body: string }> =>
      surfaceOf(await strategyRoute.GET(new Request(`https://app.test/api/companies/${companyId}/strategy`), { params: Promise.resolve({ companyId }) }));

    const postSelection = async (companyId: string, generationId: string): Promise<{ status: number; body: string }> =>
      surfaceOf(
        await selectionRoute.POST(
          new Request(`https://app.test/api/companies/${companyId}/strategy/selection`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ generationId, request: { mode: 'reject', reasons: ['no'] } }),
          }),
          { params: Promise.resolve({ companyId }) },
        ),
      );

    const postDecision = async (companyId: string, generationId: string, selectionId: string): Promise<{ status: number; body: string }> =>
      surfaceOf(
        await decisionsRoute.POST(
          new Request(`https://app.test/api/companies/${companyId}/decisions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ generationId, selectionId }),
          }),
          { params: Promise.resolve({ companyId }) },
        ),
      );

    test('G4 — a member of A cannot reach company B through any of the three, and NOTHING moves', async () => {
      await signInAs(w.aOwner);
      const before = await owner.kysely.selectFrom('strategy_selections').select('id').execute();

      expect((await getStrategy(w.companyB1)).status, 'read into B').not.toBe(200);
      expect((await postSelection(w.companyB1, genB)).status, 'select into B').not.toBe(200);
      expect((await postDecision(w.companyB1, genB, UNKNOWN_UUID)).status, 'decide into B').not.toBe(200);

      // THE DATABASE IS THE ASSERTION, not the status code: a refusal that still wrote a row would satisfy the
      // three checks above and be exactly the defect this matrix exists to catch.
      const after = await owner.kysely.selectFrom('strategy_selections').select('id').execute();
      expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    });

    test('G7(a) — COMPANY granularity: a FOREIGN company id and an UNKNOWN one are byte-identical', async () => {
      await signInAs(w.aOwner);
      for (const [name, call] of [
        ['strategy read', (id: string) => getStrategy(id)],
        ['selection', (id: string) => postSelection(id, genA)],
        ['decision', (id: string) => postDecision(id, genA, UNKNOWN_UUID)],
      ] as const) {
        const foreign = await call(w.companyB1);
        const unknown = await call(UNKNOWN_UUID);
        expect(foreign.status, `${name}: identical status`).toBe(unknown.status);
        expect(foreign.body, `${name}: identical body`).toBe(unknown.body);
      }
    });

    test('G7(b) — SELECTION granularity: a FOREIGN selection id and an UNKNOWN one are byte-identical', async () => {
      // Inside company A, which this caller legitimately holds — so the only thing under test is whether the
      // SUB-RESOURCE leaks. This is the granularity §4 originally missed.
      await signInAs(w.aOwner);
      const foreignSelection = (
        await owner.kysely
          .insertInto('strategy_selections')
          // `strategy_selections_mode_shape` (migration 0024) requires reject to carry reasons and NO option and
          // NO chosen_fields. The reasons string is fixture text with no bearing on the assertion — this test
          // only cares that a selection EXISTS in company B and stays invisible from company A.
          .values({ account_id: w.accountB, company_id: w.companyB1, generation_id: genB, mode: 'reject', phase_scope: null, reasons: 'seeded foreign selection', created_by_user_id: w.bOwner })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;

      const foreign = await postDecision(w.companyA1, genA, foreignSelection);
      const unknown = await postDecision(w.companyA1, genA, UNKNOWN_UUID);
      expect(foreign.status, 'selection: identical status').toBe(unknown.status);
      expect(foreign.body, 'selection: identical body').toBe(unknown.body);
    });

    test('G6 — a malformed id never succeeds and never leaks', async () => {
      await signInAs(w.aOwner);
      for (const bad of MALFORMED) {
        for (const [name, res] of [
          ['strategy read', await getStrategy(bad)],
          ['selection', await postSelection(bad, genA)],
          ['decision', await postDecision(bad, genA, UNKNOWN_UUID)],
        ] as const) {
          expect(res.status, `${name} '${bad}' must not succeed`).not.toBe(200);
          expect(Object.keys(JSON.parse(res.body) as Record<string, unknown>), `${name} '${bad}' bounded envelope`).toEqual(['error']);
          for (const forbidden of ['select', 'insert', 'constraint', 'pg_', 'stack', 'password', w.companyB1, genB]) {
            expect(res.body.toLowerCase(), `${name} '${bad}' must not leak '${forbidden}'`).not.toContain(String(forbidden).toLowerCase());
          }
        }
      }
    });
  });
});
