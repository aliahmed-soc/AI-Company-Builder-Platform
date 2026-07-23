// ACBP-P1-013 — unit tests for the authenticated admin request use case (injected deps; no Clerk/DB).
// Proves: the acting user is ALWAYS the server-verified session user (never a request field); no personal
// account is provisioned/resolved on this path; unmapped and deleted users collapse into the SAME coarse
// forbidden as a domain denial (no mapping oracle); identity failures map faithfully; and the reason flows
// through VERBATIM without appearing in any log this layer produces.
import { describe, test, expect } from 'vitest';
import type { VerifiedIdentityDeps } from '../auth/verified-identity.js';
import { readCompanyOverviewForRequest, type AdminRuntime } from './admin-request.js';

const TARGET = { accountId: 'acc_t', companyId: 'co_t' };
const REASON = '  Ticket #9: astral \u{1F50D} check  ';
const OVERVIEW = { companyId: 'co_t', status: 'active', creationMode: 'own_idea', createdAt: '2026-07-02T00:00:00.000Z' } as const;

function identityDeps(opts: { userId?: string | null; verified?: boolean; fail?: boolean } = {}): VerifiedIdentityDeps {
  const { userId = 'clerk_adm', verified = true, fail = false } = opts;
  return {
    getUserId: () => (fail ? Promise.reject(new Error('provider down')) : Promise.resolve(userId)),
    getBackendUser: () =>
      Promise.resolve({ id: 'clerk_adm', primaryEmailAddressId: 'e1', emailAddresses: [{ id: 'e1', emailAddress: 'a@example.com', verification: { status: verified ? 'verified' : 'unverified' } }], firstName: null, lastName: null }),
  };
}

function fakeRuntime(overrides: Partial<AdminRuntime> = {}): AdminRuntime {
  return {
    resolveInternalUser: () => Promise.resolve({ status: 'active', userId: 'u_adm' }),
    adminReadCompanyOverview: () => Promise.resolve({ status: 'ok', company: OVERVIEW }),
    ...overrides,
  };
}

describe('readCompanyOverviewForRequest', () => {
  test('calls the domain with the SERVER-resolved internal user id + the raw selectors + the VERBATIM reason', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      adminReadCompanyOverview: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'ok', company: OVERVIEW });
      },
    });
    const r = await readCompanyOverviewForRequest(TARGET, REASON, { identity: identityDeps(), runtime });
    expect(r).toEqual({ status: 'ok', company: OVERVIEW });
    expect(calls).toEqual([{ userId: 'u_adm', accountId: 'acc_t', companyId: 'co_t', reason: REASON }]);
  });

  test('identity failures map faithfully and the domain is NEVER called', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      resolveInternalUser: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'active', userId: 'u_adm' });
      },
      adminReadCompanyOverview: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'ok', company: OVERVIEW });
      },
    });
    expect((await readCompanyOverviewForRequest(TARGET, REASON, { identity: identityDeps({ userId: null }), runtime })).status).toBe('unauthenticated');
    expect((await readCompanyOverviewForRequest(TARGET, REASON, { identity: identityDeps({ verified: false }), runtime })).status).toBe('email_unverified');
    expect((await readCompanyOverviewForRequest(TARGET, REASON, { identity: identityDeps({ fail: true }), runtime })).status).toBe('unavailable');
    expect(calls).toEqual([]);
  });

  test('unmapped (not_found) and deleted users collapse into the SAME coarse forbidden as a domain denial', async () => {
    const notFound = await readCompanyOverviewForRequest(TARGET, REASON, { identity: identityDeps(), runtime: fakeRuntime({ resolveInternalUser: () => Promise.resolve({ status: 'not_found' }) }) });
    const deleted = await readCompanyOverviewForRequest(TARGET, REASON, { identity: identityDeps(), runtime: fakeRuntime({ resolveInternalUser: () => Promise.resolve({ status: 'deleted' }) }) });
    const denied = await readCompanyOverviewForRequest(TARGET, REASON, { identity: identityDeps(), runtime: fakeRuntime({ adminReadCompanyOverview: () => Promise.resolve({ status: 'forbidden' }) }) });
    expect(notFound).toEqual({ status: 'forbidden' });
    expect(deleted).toEqual({ status: 'forbidden' });
    expect(denied).toEqual({ status: 'forbidden' });
  });

  test('mapping-layer unavailability surfaces as unavailable (fail-safe, not forbidden/ok)', async () => {
    const r = await readCompanyOverviewForRequest(TARGET, REASON, { identity: identityDeps(), runtime: fakeRuntime({ resolveInternalUser: () => Promise.resolve({ status: 'unavailable', error: { category: 'provider_unavailable', code: 'DEPENDENCY_UNAVAILABLE', message: 'x', retryable: true } }) }) });
    expect(r).toEqual({ status: 'unavailable' });
  });

  test('a domain invalid_reason surfaces as invalid_reason (defence-in-depth path)', async () => {
    const r = await readCompanyOverviewForRequest(TARGET, 42, { identity: identityDeps(), runtime: fakeRuntime({ adminReadCompanyOverview: () => Promise.resolve({ status: 'invalid_reason' }) }) });
    expect(r).toEqual({ status: 'invalid_reason' });
  });

  test('the reason never appears on stdout/stderr from this layer (structured logs stay reason-free)', async () => {
    const canary = 'LEAK-CANARY-LOG-MARKER-1234567890';
    const seen: string[] = [];
    const capture = (chunk: unknown): boolean => {
      seen.push(String(chunk));
      return true;
    };
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = capture;
    process.stderr.write = capture;
    try {
      await readCompanyOverviewForRequest(TARGET, canary, { identity: identityDeps(), runtime: fakeRuntime() });
      await readCompanyOverviewForRequest(TARGET, canary, { identity: identityDeps(), runtime: fakeRuntime({ adminReadCompanyOverview: () => Promise.resolve({ status: 'forbidden' }) }) });
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    expect(seen.join('')).not.toContain(canary);
  });
});
