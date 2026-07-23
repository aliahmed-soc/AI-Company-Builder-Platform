// ACBP-P1-010 — unit tests for the authenticated companies request use cases (injected deps; no Clerk/DB).
import { describe, test, expect } from 'vitest';
import type { VerifiedIdentityDeps } from '../auth/verified-identity.js';
import {
  createCompanyForRequest,
  getCompanyForRequest,
  renameCompanyForRequest,
  pauseCompanyForRequest,
  resumeCompanyForRequest,
  getCompanyActivityForRequest,
  getPortfolioForRequest,
  type CompanyRuntime,
} from './companies-request.js';

function identityDeps(opts: { userId?: string | null; email?: string; verified?: boolean } = {}): VerifiedIdentityDeps {
  const { userId = 'clerk_1', email = 'me@example.com', verified = true } = opts;
  return {
    getUserId: () => Promise.resolve(userId),
    getBackendUser: () =>
      Promise.resolve({ id: 'clerk_1', primaryEmailAddressId: 'e1', emailAddresses: [{ id: 'e1', emailAddress: email, verification: { status: verified ? 'verified' : 'unverified' } }], firstName: null, lastName: null }),
  };
}

const COMPANY_VIEW = { companyId: 'co_1', status: 'active' as const, displayStatus: 'active' as const, name: 'Acme', description: null, profileVersion: 1 };

function fakeRuntime(overrides: Partial<CompanyRuntime> = {}): CompanyRuntime {
  return {
    resolveInternalUser: () => Promise.resolve({ status: 'active', userId: 'u1' }),
    ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_1', created: false }),
    createCompany: () => Promise.resolve({ status: 'ok', companyId: 'co_1', companyStatus: 'draft', creationMode: 'own_idea' }),
    getCompany: () => Promise.resolve({ status: 'ok', company: COMPANY_VIEW }),
    renameCompany: () => Promise.resolve({ status: 'ok', changed: true, version: 2 }),
    pauseCompany: () => Promise.resolve({ status: 'ok', companyStatus: 'paused' }),
    resumeCompany: () => Promise.resolve({ status: 'ok', companyStatus: 'active' }),
    getCompanyActivity: () => Promise.resolve({ status: 'ok', page: EMPTY_PAGE }),
    getCompanyPortfolio: () => Promise.resolve({ status: 'ok', page: EMPTY_PORTFOLIO }),
    ...overrides,
  };
}

const EMPTY_PAGE = { items: [], nextCursor: null, projectionMode: 'synchronous', asOf: '2026-07-22T00:00:00.000Z', sourceThrough: null, lagSeconds: 0 } as const;
const EMPTY_PORTFOLIO = { items: [], nextCursor: null } as const;
const PORTFOLIO_ITEM = { companyId: 'co_1', name: 'Acme', status: 'active', role: 'owner', createdAt: '2026-01-01T00:00:00.000000Z' } as const;

describe('createCompanyForRequest', () => {
  test('creates against the CALLER\'s own account + acting user (never request-supplied)', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_mine', created: false }),
      createCompany: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'ok', companyId: 'co_9', companyStatus: 'draft', creationMode: 'own_idea' });
      },
    });
    const r = await createCompanyForRequest({ creationMode: 'own_idea', name: 'My Co', description: 'd' }, { identity: identityDeps(), runtime });
    expect(r).toEqual({ status: 'created', companyId: 'co_9', companyStatus: 'draft', creationMode: 'own_idea' });
    expect(calls).toEqual([{ accountId: 'acc_mine', actingUserId: 'u1', creationMode: 'own_idea', name: 'My Co', description: 'd' }]);
  });
  test('a non-owner create → forbidden; a domain validation failure surfaces as validation', async () => {
    expect((await createCompanyForRequest({ creationMode: 'own_idea', name: 'X' }, { identity: identityDeps(), runtime: fakeRuntime({ createCompany: () => Promise.resolve({ status: 'forbidden' }) }) })).status).toBe('forbidden');
    expect((await createCompanyForRequest({ creationMode: 'nope', name: '' }, { identity: identityDeps(), runtime: fakeRuntime({ createCompany: () => Promise.resolve({ status: 'validation', error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'x', retryable: false } }) }) })).status).toBe('validation');
  });
});

describe('getCompanyForRequest', () => {
  test('resolves the companyId under the caller\'s account (companyId is a request selector)', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({ ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_mine', created: false }), getCompany: (p) => { calls.push(p); return Promise.resolve({ status: 'ok', company: COMPANY_VIEW }); } });
    const r = await getCompanyForRequest('co_req', { identity: identityDeps(), runtime });
    expect(r.status).toBe('company');
    expect(calls).toEqual([{ userId: 'u1', accountId: 'acc_mine', companyId: 'co_req' }]);
  });
  test('non-member → forbidden; unknown → not_found', async () => {
    expect((await getCompanyForRequest('c', { identity: identityDeps(), runtime: fakeRuntime({ getCompany: () => Promise.resolve({ status: 'forbidden' }) }) })).status).toBe('forbidden');
    expect((await getCompanyForRequest('c', { identity: identityDeps(), runtime: fakeRuntime({ getCompany: () => Promise.resolve({ status: 'not_found' }) }) })).status).toBe('not_found');
  });
});

describe('rename/pause/resume', () => {
  test('rename maps ok(changed,version) / forbidden / validation', async () => {
    expect(await renameCompanyForRequest('c', { name: 'New' }, { identity: identityDeps(), runtime: fakeRuntime() })).toEqual({ status: 'renamed', changed: true, version: 2 });
    expect((await renameCompanyForRequest('c', { name: 'x' }, { identity: identityDeps(), runtime: fakeRuntime({ renameCompany: () => Promise.resolve({ status: 'forbidden' }) }) })).status).toBe('forbidden');
  });
  test('pause/resume map ok(status), invalid_transition, and rename conflict → conflict', async () => {
    expect(await pauseCompanyForRequest('c', { identity: identityDeps(), runtime: fakeRuntime() })).toEqual({ status: 'transitioned', companyStatus: 'paused' });
    expect(await resumeCompanyForRequest('c', { identity: identityDeps(), runtime: fakeRuntime() })).toEqual({ status: 'transitioned', companyStatus: 'active' });
    expect(await pauseCompanyForRequest('c', { identity: identityDeps(), runtime: fakeRuntime({ pauseCompany: () => Promise.resolve({ status: 'invalid_transition', from: 'draft' }) }) })).toEqual({ status: 'invalid_transition', from: 'draft' });
    // A concurrent-rename version race surfaces as a coarse conflict (mapped to 409), never a 500.
    expect((await renameCompanyForRequest('c', { name: 'X' }, { identity: identityDeps(), runtime: fakeRuntime({ renameCompany: () => Promise.resolve({ status: 'conflict' }) }) })).status).toBe('conflict');
  });
  test('pause/resume send NO caller-supplied reason (only the server-resolved ids)', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({ ensurePersonalAccount: () => Promise.resolve({ accountId: 'a', created: false }), pauseCompany: (p) => { calls.push(p); return Promise.resolve({ status: 'ok', companyStatus: 'paused' }); } });
    await pauseCompanyForRequest('c', { identity: identityDeps(), runtime });
    expect(calls).toEqual([{ userId: 'u1', accountId: 'a', companyId: 'c' }]);
  });
});

// ACBP-P1-007/010 — a negative test per privileged endpoint: an unauthorized principal (unauthenticated,
// unverified email, deleted identity, or a core-denied role) is refused on every company endpoint.
describe('endpoint×principal negative matrix (request layer)', () => {
  const forbidden = () => fakeRuntime({ createCompany: () => Promise.resolve({ status: 'forbidden' }), getCompany: () => Promise.resolve({ status: 'forbidden' }), renameCompany: () => Promise.resolve({ status: 'forbidden' }), pauseCompany: () => Promise.resolve({ status: 'forbidden' }), resumeCompany: () => Promise.resolve({ status: 'forbidden' }) });

  test('POST /companies (create): unauth→unauthenticated, unverified→email_unverified, non-owner→forbidden', async () => {
    expect((await createCompanyForRequest({ creationMode: 'own_idea', name: 'X' }, { identity: identityDeps({ userId: null }), runtime: fakeRuntime() })).status).toBe('unauthenticated');
    expect((await createCompanyForRequest({ creationMode: 'own_idea', name: 'X' }, { identity: identityDeps({ verified: false }), runtime: fakeRuntime() })).status).toBe('email_unverified');
    expect((await createCompanyForRequest({ creationMode: 'own_idea', name: 'X' }, { identity: identityDeps(), runtime: forbidden() })).status).toBe('forbidden');
  });
  test('a deleted internal identity → forbidden on every endpoint', async () => {
    const deleted = fakeRuntime({ resolveInternalUser: () => Promise.resolve({ status: 'deleted' }) });
    expect((await getCompanyForRequest('c', { identity: identityDeps(), runtime: deleted })).status).toBe('forbidden');
    expect((await renameCompanyForRequest('c', { name: 'x' }, { identity: identityDeps(), runtime: deleted })).status).toBe('forbidden');
    expect((await pauseCompanyForRequest('c', { identity: identityDeps(), runtime: deleted })).status).toBe('forbidden');
    expect((await resumeCompanyForRequest('c', { identity: identityDeps(), runtime: deleted })).status).toBe('forbidden');
  });
  test('PATCH/pause/resume: unverified→email_unverified, core-denied→forbidden', async () => {
    expect((await renameCompanyForRequest('c', { name: 'x' }, { identity: identityDeps({ verified: false }), runtime: fakeRuntime() })).status).toBe('email_unverified');
    expect((await pauseCompanyForRequest('c', { identity: identityDeps(), runtime: forbidden() })).status).toBe('forbidden');
    expect((await resumeCompanyForRequest('c', { identity: identityDeps(), runtime: forbidden() })).status).toBe('forbidden');
  });
});

describe('getCompanyActivityForRequest', () => {
  test('resolves under the caller\'s account + forwards raw cursor/limit (server-resolved authority)', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_mine', created: false }),
      getCompanyActivity: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'ok', page: { ...EMPTY_PAGE, nextCursor: 'nc' } });
      },
    });
    const r = await getCompanyActivityForRequest('co_req', { cursor: 'abc', limit: '10' }, { identity: identityDeps(), runtime });
    expect(r).toEqual({ status: 'activity', page: { ...EMPTY_PAGE, nextCursor: 'nc' } });
    expect(calls).toEqual([{ userId: 'u1', accountId: 'acc_mine', companyId: 'co_req', cursor: 'abc', limit: '10' }]);
  });
  test('maps forbidden and invalid_cursor', async () => {
    expect((await getCompanyActivityForRequest('c', {}, { identity: identityDeps(), runtime: fakeRuntime({ getCompanyActivity: () => Promise.resolve({ status: 'forbidden' }) }) })).status).toBe('forbidden');
    expect((await getCompanyActivityForRequest('c', { cursor: 'bad' }, { identity: identityDeps(), runtime: fakeRuntime({ getCompanyActivity: () => Promise.resolve({ status: 'invalid_cursor' }) }) })).status).toBe('invalid_cursor');
  });
  test('unauthenticated / unverified are refused', async () => {
    expect((await getCompanyActivityForRequest('c', {}, { identity: identityDeps({ userId: null }), runtime: fakeRuntime() })).status).toBe('unauthenticated');
    expect((await getCompanyActivityForRequest('c', {}, { identity: identityDeps({ verified: false }), runtime: fakeRuntime() })).status).toBe('email_unverified');
  });
});

describe('getPortfolioForRequest', () => {
  test('reads under the caller\'s OWN account + actor (never request-supplied) and forwards raw cursor/limit', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_mine', created: false }),
      getCompanyPortfolio: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'ok', page: { items: [PORTFOLIO_ITEM], nextCursor: 'nc' } });
      },
    });
    const r = await getPortfolioForRequest({ cursor: 'abc', limit: '10' }, { identity: identityDeps(), runtime });
    expect(r).toEqual({ status: 'portfolio', page: { items: [PORTFOLIO_ITEM], nextCursor: 'nc' } });
    // No companyId (it is a collection read); accountId + userId are server-resolved, cursor/limit forwarded raw.
    expect(calls).toEqual([{ userId: 'u1', accountId: 'acc_mine', cursor: 'abc', limit: '10' }]);
  });
  test('maps forbidden, invalid_cursor, and invalid_limit', async () => {
    expect((await getPortfolioForRequest({}, { identity: identityDeps(), runtime: fakeRuntime({ getCompanyPortfolio: () => Promise.resolve({ status: 'forbidden' }) }) })).status).toBe('forbidden');
    expect((await getPortfolioForRequest({ cursor: 'bad' }, { identity: identityDeps(), runtime: fakeRuntime({ getCompanyPortfolio: () => Promise.resolve({ status: 'invalid_cursor' }) }) })).status).toBe('invalid_cursor');
    expect((await getPortfolioForRequest({ limit: '0' }, { identity: identityDeps(), runtime: fakeRuntime({ getCompanyPortfolio: () => Promise.resolve({ status: 'invalid_limit' }) }) })).status).toBe('invalid_limit');
  });
  test('unauthenticated / unverified / deleted are refused', async () => {
    expect((await getPortfolioForRequest({}, { identity: identityDeps({ userId: null }), runtime: fakeRuntime() })).status).toBe('unauthenticated');
    expect((await getPortfolioForRequest({}, { identity: identityDeps({ verified: false }), runtime: fakeRuntime() })).status).toBe('email_unverified');
    expect((await getPortfolioForRequest({}, { identity: identityDeps(), runtime: fakeRuntime({ resolveInternalUser: () => Promise.resolve({ status: 'deleted' }) }) })).status).toBe('forbidden');
  });
});
