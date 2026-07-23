// ACBP-P1-013 — unit tests for the admin route's strict parsing, safe mapping and full POST handler.
// Trust-critical at this boundary: EXACT `{ reason }` body (unknown properties REJECTED), every query
// parameter rejected, reason validated BEFORE any identity/domain work (the runtime is provably not touched
// on parse failure), one generic 400 for every malformed cause, one opaque 403 for every denial, exactly the
// four approved response fields, and no reason/accountId/actor/SQL/stack leakage on any path.
import { describe, test, expect } from 'vitest';
import { parseAdminReadBody, toAdminReadResponse, handleAdminReadPost, MAX_ADMIN_BODY_BYTES } from './admin-http.js';
import type { AdminRequestResult, AdminRuntime } from './admin-request.js';
import type { VerifiedIdentityDeps } from '../auth/verified-identity.js';

const NUL = String.fromCharCode(0);

function req(contentType: string | null, bodyStr: string, opts: { declaredLength?: number; url?: string } = {}): Parameters<typeof handleAdminReadPost>[0] {
  const bytes = new TextEncoder().encode(bodyStr);
  const len = opts.declaredLength ?? bytes.byteLength;
  return {
    url: opts.url ?? 'https://app.example.test/api/admin/accounts/acc_1/companies/co_1/read',
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : k.toLowerCase() === 'content-length' ? String(len) : null) },
    body: null,
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  };
}

const REASON = 'Ticket #12: verify reported company state';

function identityDeps(): VerifiedIdentityDeps {
  return {
    getUserId: () => Promise.resolve('clerk_adm'),
    getBackendUser: () => Promise.resolve({ id: 'clerk_adm', primaryEmailAddressId: 'e1', emailAddresses: [{ id: 'e1', emailAddress: 'a@example.com', verification: { status: 'verified' } }], firstName: null, lastName: null }),
  };
}

function fakeRuntime(overrides: Partial<AdminRuntime> = {}): AdminRuntime {
  return {
    resolveInternalUser: () => Promise.resolve({ status: 'active', userId: 'u_adm' }),
    adminReadCompanyOverview: () => Promise.resolve({ status: 'ok', company: { companyId: 'co_1', status: 'active', creationMode: 'own_idea', createdAt: '2026-07-01T00:00:00.000Z' } }),
    ...overrides,
  };
}

describe('parseAdminReadBody — strict `{ reason }` only', () => {
  test('valid body → the VERBATIM reason (whitespace preserved, never trimmed)', async () => {
    expect(await parseAdminReadBody(req('application/json', JSON.stringify({ reason: REASON })))).toEqual({ ok: true, reason: REASON });
    expect(await parseAdminReadBody(req('application/json', JSON.stringify({ reason: '  padded  ' })))).toEqual({ ok: true, reason: '  padded  ' });
  });
  test.each([
    ['no content-type', req(null, JSON.stringify({ reason: REASON }))],
    ['non-JSON content-type', req('text/plain', JSON.stringify({ reason: REASON }))],
    ['empty body', req('application/json', '')],
    ['invalid JSON', req('application/json', '{bad')],
    ['JSON array', req('application/json', '[{"reason":"x"}]')],
    ['JSON string scalar', req('application/json', '"reason"')],
    ['JSON null', req('application/json', 'null')],
    ['empty object (reason missing)', req('application/json', '{}')],
    ['non-string reason (number)', req('application/json', JSON.stringify({ reason: 42 }))],
    ['non-string reason (null)', req('application/json', JSON.stringify({ reason: null }))],
    ['blank reason', req('application/json', JSON.stringify({ reason: '   ' }))],
    ['oversized reason (513 code points)', req('application/json', JSON.stringify({ reason: 'x'.repeat(513) }))],
    ['NUL in reason', req('application/json', JSON.stringify({ reason: `bad${NUL}reason` }))],
    ['unknown extra property', req('application/json', JSON.stringify({ reason: REASON, scope: 'company_overview' }))],
    ['injection-shaped extra property', req('application/json', JSON.stringify({ reason: REASON, accountId: 'evil' }))],
    ['only an unknown property', req('application/json', JSON.stringify({ Reason: REASON }))],
    ['declared length over cap', req('application/json', JSON.stringify({ reason: REASON }), { declaredLength: MAX_ADMIN_BODY_BYTES + 1 })],
  ])('%s → one indistinct failure', async (_label, request) => {
    expect(await parseAdminReadBody(request)).toEqual({ ok: false });
  });
  test('a 512-code-point reason (the exact bound) is accepted', async () => {
    const max = 'y'.repeat(512);
    expect(await parseAdminReadBody(req('application/json', JSON.stringify({ reason: max })))).toEqual({ ok: true, reason: max });
  });
});

describe('toAdminReadResponse — bounded mapping', () => {
  test('ok → 200 with EXACTLY the four approved fields (no reason echo, no accountId)', async () => {
    const res = toAdminReadResponse({ status: 'ok', company: { companyId: 'co_1', status: 'active', creationMode: 'own_idea', createdAt: '2026-07-01T00:00:00.000Z' } });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ companyId: 'co_1', status: 'active', creationMode: 'own_idea', createdAt: '2026-07-01T00:00:00.000Z' });
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(['companyId', 'createdAt', 'creationMode', 'status']);
    expect(res.headers.get('cache-control')).toBeNull(); // no cache directive is set; the route is force-dynamic
  });
  const cases: ReadonlyArray<[AdminRequestResult, number, string]> = [
    [{ status: 'invalid_reason' }, 400, 'bad_request'],
    [{ status: 'forbidden' }, 403, 'forbidden'],
    [{ status: 'email_unverified' }, 403, 'forbidden'],
    [{ status: 'unauthenticated' }, 401, 'unauthorized'],
    [{ status: 'unavailable' }, 503, 'unavailable'],
  ];
  test.each(cases)('%o → %i (opaque body)', async (result, status, error) => {
    const res = toAdminReadResponse(result);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });
  test('email_unverified and forbidden are byte-identical (no denial-class oracle)', async () => {
    const a = toAdminReadResponse({ status: 'forbidden' });
    const b = toAdminReadResponse({ status: 'email_unverified' });
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  });
});

describe('handleAdminReadPost — the full handler', () => {
  const TARGET = { accountId: 'acc_1', companyId: 'co_1' };
  const tracking = (): { runtime: AdminRuntime; calls: unknown[] } => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      resolveInternalUser: (p) => {
        calls.push(['resolve', p]);
        return Promise.resolve({ status: 'active', userId: 'u_adm' });
      },
      adminReadCompanyOverview: (p) => {
        calls.push(['read', p]);
        return Promise.resolve({ status: 'ok', company: { companyId: 'co_1', status: 'active', creationMode: 'own_idea', createdAt: '2026-07-01T00:00:00.000Z' } });
      },
    });
    return { runtime, calls };
  };

  test('every query parameter is rejected (400) BEFORE parsing or any service call', async () => {
    const { runtime, calls } = tracking();
    for (const qs of ['?debug=1', '?reason=x', '?accountId=other', '?=']) {
      const res = await handleAdminReadPost(req('application/json', JSON.stringify({ reason: REASON }), { url: `https://app.example.test/api/admin/accounts/acc_1/companies/co_1/read${qs}` }), TARGET, { identity: identityDeps(), runtime });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
    expect(calls).toEqual([]);
  });

  test('parse failure → 400 and the service/identity layer is NEVER invoked', async () => {
    const { runtime, calls } = tracking();
    const identity: VerifiedIdentityDeps = {
      getUserId: () => {
        calls.push(['identity']);
        return Promise.resolve('clerk_adm');
      },
      getBackendUser: () => Promise.reject(new Error('must not be called')),
    };
    for (const bad of ['{bad', '{}', JSON.stringify({ reason: REASON, extra: 1 }), JSON.stringify({ reason: '   ' }), JSON.stringify({ reason: `x${NUL}` })]) {
      expect((await handleAdminReadPost(req('application/json', bad), TARGET, { identity, runtime })).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test('success: passes the route selectors + verbatim reason; responds with exactly the four fields', async () => {
    const { runtime, calls } = tracking();
    const res = await handleAdminReadPost(req('application/json', JSON.stringify({ reason: REASON })), TARGET, { identity: identityDeps(), runtime });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ companyId: 'co_1', status: 'active', creationMode: 'own_idea', createdAt: '2026-07-01T00:00:00.000Z' });
    expect(calls).toEqual([
      ['resolve', 'clerk_adm'],
      ['read', { userId: 'u_adm', accountId: 'acc_1', companyId: 'co_1', reason: REASON }],
    ]);
  });

  test('a domain denial maps to the ONE opaque 403 whatever the cause', async () => {
    for (const runtime of [
      fakeRuntime({ adminReadCompanyOverview: () => Promise.resolve({ status: 'forbidden' }) }),
      fakeRuntime({ resolveInternalUser: () => Promise.resolve({ status: 'not_found' }) }),
      fakeRuntime({ resolveInternalUser: () => Promise.resolve({ status: 'deleted' }) }),
    ]) {
      const res = await handleAdminReadPost(req('application/json', JSON.stringify({ reason: REASON })), TARGET, { identity: identityDeps(), runtime });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    }
  });

  test('an audit/internal failure maps to the BOUNDED generic 500 — no reason/target/stack in the body', async () => {
    const runtime = fakeRuntime({ adminReadCompanyOverview: () => Promise.reject(new Error(`audit boom for ${REASON} on acc_1`)) });
    const res = await handleAdminReadPost(req('application/json', JSON.stringify({ reason: REASON })), TARGET, { identity: identityDeps(), runtime });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal_error' });
    expect(text).not.toContain(REASON);
    expect(text).not.toContain('acc_1');
    expect(text).not.toContain('boom');
    expect(text).not.toContain('stack');
  });

  test('no error path ever echoes the reason or selectors', async () => {
    const canary = 'LEAK-CANARY-REASON-MARKER-77';
    for (const [runtime, expected] of [
      [fakeRuntime({ adminReadCompanyOverview: () => Promise.resolve({ status: 'forbidden' }) }), 403],
      [fakeRuntime({ adminReadCompanyOverview: () => Promise.resolve({ status: 'invalid_reason' }) }), 400],
      [fakeRuntime({ adminReadCompanyOverview: () => Promise.reject(new Error('x')) }), 500],
    ] as ReadonlyArray<[AdminRuntime, number]>) {
      const res = await handleAdminReadPost(req('application/json', JSON.stringify({ reason: canary })), { accountId: 'acc_CANARY', companyId: 'co_1' }, { identity: identityDeps(), runtime });
      expect(res.status).toBe(expected);
      const text = await res.text();
      expect(text).not.toContain(canary);
      expect(text).not.toContain('acc_CANARY');
    }
  });
});
