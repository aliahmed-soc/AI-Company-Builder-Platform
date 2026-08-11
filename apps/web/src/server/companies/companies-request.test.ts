// ACBP-P1-010 — unit tests for the authenticated companies request use cases (injected deps; no Clerk/DB).
import { describe, test, expect } from 'vitest';
import { DECISION_ROOM_QUEUES, okSection, type DecisionRoomView } from '@acbp/contracts';
import type { VerifiedIdentityDeps } from '../auth/verified-identity.js';
import {
  createCompanyForRequest,
  getCompanyForRequest,
  renameCompanyForRequest,
  pauseCompanyForRequest,
  resumeCompanyForRequest,
  getCompanyActivityForRequest,
  getDecisionRoomForRequest,
  getStrategyForRequest,
  recordStrategySelectionForRequest,
  recordDecisionForRequest,
  getPortfolioForRequest,
  getProvisioningForRequest,
  resumeProvisioningForRequest,
  startInterviewForRequest,
  suspendInterviewForRequest,
  resumeInterviewForRequest,
  getInterviewForRequest,
  recordAnswerForRequest,
  getQaForRequest,
  createMemoryForRequest,
  listMemoryForRequest,
  editMemoryForRequest,
  getMemoryForRequest,
  deleteMemoryForRequest,
  type CompanyRuntime,
} from './companies-request.js';

function identityDeps(opts: { userId?: string | null; email?: string; verified?: boolean } = {}): VerifiedIdentityDeps {
  const { userId = 'clerk_1', email = 'me@example.com', verified = true } = opts;
  return {
    getUserId: () => Promise.resolve(userId),
    // ACBP-P7-013: both REQUIRED, never defaulted — a limiter that defaults to allowed is the
    // P6-007 stop-port defect (CDR-072 section 1-G1). A test that wants to be admitted says so.
    getSessionId: () => Promise.resolve('sess_test'),
    checkSessionLimit: () => Promise.resolve({ kind: 'allowed' } as const),
    getBackendUser: () =>
      Promise.resolve({ id: 'clerk_1', primaryEmailAddressId: 'e1', emailAddresses: [{ id: 'e1', emailAddress: email, verification: { status: verified ? 'verified' : 'unverified' } }], firstName: null, lastName: null }),
  };
}

const COMPANY_VIEW = { companyId: 'co_1', status: 'active' as const, displayStatus: 'active' as const, name: 'Acme', description: null, profileVersion: 1 };

function fakeRuntime(overrides: Partial<CompanyRuntime> = {}): CompanyRuntime {
  return {
    // ACBP-P7-013: REQUIRED on the runtime, so a fake cannot be admitted by omission (CDR-082 section 2).
    checkRequestLimit: () => Promise.resolve({ kind: 'allowed' } as const),
    resolveInternalUser: () => Promise.resolve({ status: 'active', userId: 'u1' }),
    ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_1', created: false }),
    createCompany: () => Promise.resolve({ status: 'ok', companyId: 'co_1', companyStatus: 'draft', creationMode: 'own_idea' }),
    getCompany: () => Promise.resolve({ status: 'ok', company: COMPANY_VIEW }),
    renameCompany: () => Promise.resolve({ status: 'ok', changed: true, version: 2 }),
    pauseCompany: () => Promise.resolve({ status: 'ok', companyStatus: 'paused' }),
    resumeCompany: () => Promise.resolve({ status: 'ok', companyStatus: 'active' }),
    getCompanyActivity: () => Promise.resolve({ status: 'ok', page: EMPTY_PAGE }),
    readDecisionRoom: () => Promise.resolve({ status: 'ok', room: EMPTY_ROOM }),
    getCompanyPortfolio: () => Promise.resolve({ status: 'ok', page: EMPTY_PORTFOLIO }),
    getProvisioningStatus: () => Promise.resolve({ status: 'ok', provisioning: PROVISIONING_DTO }),
    resumeProvisioning: () => Promise.resolve({ status: 'ok', provisioning: PROVISIONING_DTO }),
    startInterviewSession: () => Promise.resolve({ status: 'ok', session: INTERVIEW_DTO, created: true }),
    suspendInterviewSession: () => Promise.resolve({ status: 'ok', session: { ...INTERVIEW_DTO, state: 'waiting_for_user', phase: 'awaiting_input' } }),
    resumeInterviewSession: () => Promise.resolve({ status: 'ok', session: INTERVIEW_DTO }),
    getInterviewSession: () => Promise.resolve({ status: 'ok', session: INTERVIEW_DTO }),
    recordInterviewAnswer: () => Promise.resolve({ status: 'ok', answer: ANSWER_DTO, created: true }),
    getSessionQa: () => Promise.resolve({ status: 'ok', qa: QA_DTO }),
    createMemoryItem: () => Promise.resolve({ status: 'ok', item: MEMORY_DTO }),
    listMemoryItems: () => Promise.resolve({ status: 'ok', items: [MEMORY_DTO] }),
    editMemoryItem: () => Promise.resolve({ status: 'ok', item: MEMORY_DTO }),
    getMemoryItem: () => Promise.resolve({ status: 'ok', item: MEMORY_DTO }),
    deleteMemoryItem: () => Promise.resolve({ status: 'ok', memoryItemId: 'mem_1' }),
    // CDR-087 G3.1 — these THROW rather than returning undefined. A fixture that cannot produce the thing under
    // test must fail loudly; ACBP-P6-007 is the case where a null-returning fixture hid two emergency-stop
    // scopes that were enforcing nothing. Every test needing one of these stubs it explicitly.
    getLatestStrategy: () => Promise.reject(new Error('getLatestStrategy: unstubbed in this fake runtime')),
    recordStrategySelection: () => Promise.reject(new Error('recordStrategySelection: unstubbed in this fake runtime')),
    recordDecision: () => Promise.reject(new Error('recordDecision: unstubbed in this fake runtime')),
    ...overrides,
  };
}

const INTERVIEW_DTO = { sessionId: 'sess_1', companyId: 'co_1', state: 'in_progress' as const, phase: 'in_progress' as const, startedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
const ANSWER_DTO = { questionId: 'q_1', revision: 1, status: 'answered' as const, content: 'hi', createdAt: '2026-01-01T00:00:00.000Z' };
const QA_DTO = { sessionId: 'sess_1', items: [] as const };
const MEMORY_DTO = { memoryItemId: 'mem_1', type: 'user_fact' as const, content: 'hi', sourceType: 'interview_answer' as const, sourceRef: 'q1:1', confidence: null, confirmationState: 'proposed' as const, supersededBy: null, createdAt: '2026-01-01T00:00:00.000Z' };
const EMPTY_PAGE = { items: [], nextCursor: null, projectionMode: 'synchronous', asOf: '2026-07-22T00:00:00.000Z', sourceThrough: null, lagSeconds: 0 } as const;
const EMPTY_PORTFOLIO = { items: [], nextCursor: null } as const;
const EMPTY_ROOM: DecisionRoomView = {
  sections: DECISION_ROOM_QUEUES.map((q) => okSection(q, [], 0)),
  integrity: { unverifiedCompletions: 0 },
  usage: { status: 'ok', figures: null },
  asOf: '2026-08-01T00:00:00.000Z',
  digest: 'd1',
};
const PORTFOLIO_ITEM = { companyId: 'co_1', name: 'Acme', status: 'active', role: 'owner', createdAt: '2026-01-01T00:00:00.000000Z' } as const;
const PROVISIONING_DTO = {
  companyId: 'co_1',
  companyStatus: 'onboarding',
  steps: [{ step: 'profile' as const, order: 1, status: 'pending' as const, attempt: 0, requestedAt: '2026-01-01T00:00:00.000Z', startedAt: null, completedAt: null, failedAt: null, failureCode: null }],
  nextIncompleteStep: 'profile' as const,
  resumable: true,
  exhausted: false,
  completed: false,
} as const;

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

// ACBP-P6-008 — the Decision Room request use case (DEC-001).
describe('getDecisionRoomForRequest', () => {
  test('passes ONLY server-resolved ids and the selector — the caller cannot name a section, filter or account', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_mine', created: false }),
      readDecisionRoom: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'ok', room: EMPTY_ROOM });
      },
    });
    const r = await getDecisionRoomForRequest('co_req', { identity: identityDeps(), runtime });
    expect(r).toEqual({ status: 'decision_room', room: EMPTY_ROOM });
    expect(calls).toEqual([{ userId: 'u1', accountId: 'acc_mine', companyId: 'co_req' }]);
  });
  test('a non-member is refused with the SAME coarse forbidden as every other company read (no oracle)', async () => {
    // The domain has no `not_found` outcome here BY DESIGN, so unknown, foreign and unauthorized companies are
    // one answer: this surface cannot be used to discover whether a company id exists.
    expect((await getDecisionRoomForRequest('c', { identity: identityDeps(), runtime: fakeRuntime({ readDecisionRoom: () => Promise.resolve({ status: 'forbidden' }) }) })).status).toBe('forbidden');
  });
  test('an unauthenticated or unverified caller never reaches the domain', async () => {
    let reached = false;
    const runtime = fakeRuntime({ readDecisionRoom: () => { reached = true; return Promise.resolve({ status: 'ok', room: EMPTY_ROOM }); } });
    expect((await getDecisionRoomForRequest('c', { identity: identityDeps({ userId: null }), runtime })).status).toBe('unauthenticated');
    expect((await getDecisionRoomForRequest('c', { identity: identityDeps({ verified: false }), runtime })).status).toBe('email_unverified');
    expect(reached).toBe(false);
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

describe('provisioning requests (ACBP-P1-012)', () => {
  test('GET resolves under the caller\'s own account; companyId is the only route input', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_mine', created: false }),
      getProvisioningStatus: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'ok', provisioning: PROVISIONING_DTO });
      },
    });
    const r = await getProvisioningForRequest('co_req', { identity: identityDeps(), runtime });
    expect(r).toEqual({ status: 'provisioning', provisioning: PROVISIONING_DTO });
    expect(calls).toEqual([{ userId: 'u1', accountId: 'acc_mine', companyId: 'co_req' }]);
  });
  test('resume maps ok / conflict (exhausted) / forbidden (viewer or non-member)', async () => {
    expect((await resumeProvisioningForRequest('c', { identity: identityDeps(), runtime: fakeRuntime() })).status).toBe('provisioning');
    expect((await resumeProvisioningForRequest('c', { identity: identityDeps(), runtime: fakeRuntime({ resumeProvisioning: () => Promise.resolve({ status: 'conflict' }) }) })).status).toBe('conflict');
    expect((await resumeProvisioningForRequest('c', { identity: identityDeps(), runtime: fakeRuntime({ resumeProvisioning: () => Promise.resolve({ status: 'forbidden' }) }) })).status).toBe('forbidden');
    expect((await getProvisioningForRequest('c', { identity: identityDeps(), runtime: fakeRuntime({ getProvisioningStatus: () => Promise.resolve({ status: 'forbidden' }) }) })).status).toBe('forbidden');
  });
  test('unauthenticated / unverified / deleted are refused on both endpoints', async () => {
    expect((await getProvisioningForRequest('c', { identity: identityDeps({ userId: null }), runtime: fakeRuntime() })).status).toBe('unauthenticated');
    expect((await resumeProvisioningForRequest('c', { identity: identityDeps({ verified: false }), runtime: fakeRuntime() })).status).toBe('email_unverified');
    expect((await resumeProvisioningForRequest('c', { identity: identityDeps(), runtime: fakeRuntime({ resolveInternalUser: () => Promise.resolve({ status: 'deleted' }) }) })).status).toBe('forbidden');
  });
});

describe('interview requests (ACBP-P2-001)', () => {
  test('start resolves under the caller\'s own account; companyId is the only route input', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_mine', created: false }),
      startInterviewSession: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'ok', session: INTERVIEW_DTO, created: true });
      },
    });
    const r = await startInterviewForRequest('co_req', { identity: identityDeps(), runtime });
    expect(r).toEqual({ status: 'interview', session: INTERVIEW_DTO });
    expect(calls).toEqual([{ userId: 'u1', accountId: 'acc_mine', companyId: 'co_req' }]);
  });

  test('start maps company_not_active / forbidden; get + transitions map ok / not_found / invalid_transition', async () => {
    expect((await startInterviewForRequest('c', { identity: identityDeps(), runtime: fakeRuntime({ startInterviewSession: () => Promise.resolve({ status: 'company_not_active' }) }) })).status).toBe('company_not_active');
    expect((await startInterviewForRequest('c', { identity: identityDeps(), runtime: fakeRuntime({ startInterviewSession: () => Promise.resolve({ status: 'forbidden' }) }) })).status).toBe('forbidden');
    expect((await getInterviewForRequest('c', { identity: identityDeps(), runtime: fakeRuntime() })).status).toBe('interview');
    expect((await getInterviewForRequest('c', { identity: identityDeps(), runtime: fakeRuntime({ getInterviewSession: () => Promise.resolve({ status: 'not_found' }) }) })).status).toBe('not_found');
    expect((await suspendInterviewForRequest('c', { identity: identityDeps(), runtime: fakeRuntime() })).status).toBe('interview');
    expect((await resumeInterviewForRequest('c', { identity: identityDeps(), runtime: fakeRuntime() })).status).toBe('interview');
    const invalid = await resumeInterviewForRequest('c', { identity: identityDeps(), runtime: fakeRuntime({ resumeInterviewSession: () => Promise.resolve({ status: 'invalid_transition', from: 'in_progress' }) }) });
    expect(invalid).toEqual({ status: 'invalid_transition', from: 'in_progress' });
    expect((await suspendInterviewForRequest('c', { identity: identityDeps(), runtime: fakeRuntime({ suspendInterviewSession: () => Promise.resolve({ status: 'not_found' }) }) })).status).toBe('not_found');
  });

  test('unauthenticated / unverified / deleted are refused across the interview endpoints', async () => {
    expect((await startInterviewForRequest('c', { identity: identityDeps({ userId: null }), runtime: fakeRuntime() })).status).toBe('unauthenticated');
    expect((await getInterviewForRequest('c', { identity: identityDeps({ verified: false }), runtime: fakeRuntime() })).status).toBe('email_unverified');
    expect((await resumeInterviewForRequest('c', { identity: identityDeps(), runtime: fakeRuntime({ resolveInternalUser: () => Promise.resolve({ status: 'deleted' }) }) })).status).toBe('forbidden');
  });
});

describe('Q&A requests (ACBP-P2-002)', () => {
  test('record answer resolves the open session then persists; get reads it', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_mine', created: false }),
      getInterviewSession: () => Promise.resolve({ status: 'ok', session: INTERVIEW_DTO }),
      recordInterviewAnswer: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'ok', answer: ANSWER_DTO, created: true });
      },
    });
    const r = await recordAnswerForRequest('co_req', 'q_9', { status: 'answered', content: 'hi' }, { identity: identityDeps(), runtime });
    expect(r).toEqual({ status: 'answer', answer: ANSWER_DTO, created: true });
    // The session id came from the resolved OPEN session, not the client.
    expect(calls).toEqual([{ userId: 'u1', accountId: 'acc_mine', companyId: 'co_req', sessionId: 'sess_1', questionId: 'q_9', status: 'answered', content: 'hi' }]);
    expect((await getQaForRequest('co_req', { identity: identityDeps(), runtime })).status).toBe('qa');
  });

  test('no open session → not_found; forbidden + validation propagate; idempotent no-op → created:false', async () => {
    // No open interview session collapses both Q&A endpoints to not_found (never leaks that questions exist).
    const noSession = fakeRuntime({ getInterviewSession: () => Promise.resolve({ status: 'not_found' }) });
    expect((await recordAnswerForRequest('c', 'q', { status: 'answered', content: 'x' }, { identity: identityDeps(), runtime: noSession })).status).toBe('not_found');
    expect((await getQaForRequest('c', { identity: identityDeps(), runtime: noSession })).status).toBe('not_found');
    // A forbidden session resolution is forbidden.
    expect((await getQaForRequest('c', { identity: identityDeps(), runtime: fakeRuntime({ getInterviewSession: () => Promise.resolve({ status: 'forbidden' }) }) })).status).toBe('forbidden');
    // Domain outcomes propagate.
    expect((await recordAnswerForRequest('c', 'q', { status: 'skipped' }, { identity: identityDeps(), runtime: fakeRuntime({ recordInterviewAnswer: () => Promise.resolve({ status: 'ok', answer: ANSWER_DTO, created: false }) }) }))).toEqual({ status: 'answer', answer: ANSWER_DTO, created: false });
    expect((await recordAnswerForRequest('c', 'q', { status: 'bad' }, { identity: identityDeps(), runtime: fakeRuntime({ recordInterviewAnswer: () => Promise.resolve({ status: 'validation', error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'x', retryable: false } }) }) })).status).toBe('validation');
    expect((await recordAnswerForRequest('c', 'q', { status: 'answered', content: 'x' }, { identity: identityDeps(), runtime: fakeRuntime({ recordInterviewAnswer: () => Promise.resolve({ status: 'not_found' }) }) })).status).toBe('not_found');
  });

  test('unauthenticated / unverified refused on the Q&A endpoints', async () => {
    expect((await recordAnswerForRequest('c', 'q', { status: 'answered', content: 'x' }, { identity: identityDeps({ userId: null }), runtime: fakeRuntime() })).status).toBe('unauthenticated');
    expect((await getQaForRequest('c', { identity: identityDeps({ verified: false }), runtime: fakeRuntime() })).status).toBe('email_unverified');
  });
});

describe('typed memory requests (ACBP-P2-006)', () => {
  const body = { type: 'user_fact', content: 'hi', sourceType: 'interview_answer', sourceRef: 'q1:1', confidence: null };
  test('create resolves the caller account then persists; list reads', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_mine', created: false }),
      createMemoryItem: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'ok', item: MEMORY_DTO });
      },
    });
    const r = await createMemoryForRequest('co_req', body, { identity: identityDeps(), runtime });
    expect(r).toEqual({ status: 'memory_item', item: MEMORY_DTO });
    // account + user are server-resolved; company is the selector; the raw body fields pass through to the domain.
    expect(calls).toEqual([{ userId: 'u1', accountId: 'acc_mine', companyId: 'co_req', type: 'user_fact', content: 'hi', sourceType: 'interview_answer', sourceRef: 'q1:1', confidence: null }]);
    expect((await listMemoryForRequest('co_req', {}, { identity: identityDeps(), runtime })).status).toBe('memory_list');
  });

  test('forbidden + validation propagate; a request cannot forge account/company (they are server-resolved)', async () => {
    expect((await createMemoryForRequest('c', body, { identity: identityDeps(), runtime: fakeRuntime({ createMemoryItem: () => Promise.resolve({ status: 'forbidden' }) }) })).status).toBe('forbidden');
    expect((await createMemoryForRequest('c', body, { identity: identityDeps(), runtime: fakeRuntime({ createMemoryItem: () => Promise.resolve({ status: 'validation', error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'x', retryable: false } }) }) })).status).toBe('validation');
    expect((await listMemoryForRequest('c', {}, { identity: identityDeps(), runtime: fakeRuntime({ listMemoryItems: () => Promise.resolve({ status: 'forbidden' }) }) })).status).toBe('forbidden');
  });

  test('edit (supersede) + get: statuses propagate; the filter passes through to the runtime', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_mine', created: false }),
      listMemoryItems: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'ok', items: [MEMORY_DTO] });
      },
    });
    // The type + currentOnly filter reaches the runtime with server-resolved account/company.
    await listMemoryForRequest('co_f', { type: 'user_fact', currentOnly: true }, { identity: identityDeps(), runtime });
    expect(calls).toEqual([{ userId: 'u1', accountId: 'acc_mine', companyId: 'co_f', type: 'user_fact', currentOnly: true }]);
    // edit → memory_edited (200); get → memory_item_single.
    expect((await editMemoryForRequest('c', 'm1', { type: 'user_fact', content: 'x', confidence: null }, { identity: identityDeps(), runtime: fakeRuntime() }))).toEqual({ status: 'memory_edited', item: MEMORY_DTO });
    expect((await getMemoryForRequest('c', 'm1', { identity: identityDeps(), runtime: fakeRuntime() })).status).toBe('memory_item_single');
    // edit domain outcomes propagate: forbidden (viewer), conflict (version guard), not_found, validation.
    expect((await editMemoryForRequest('c', 'm1', { type: 'x', content: 'y', confidence: null }, { identity: identityDeps(), runtime: fakeRuntime({ editMemoryItem: () => Promise.resolve({ status: 'conflict' }) }) })).status).toBe('conflict');
    expect((await editMemoryForRequest('c', 'm1', { type: 'x', content: 'y', confidence: null }, { identity: identityDeps(), runtime: fakeRuntime({ editMemoryItem: () => Promise.resolve({ status: 'forbidden' }) }) })).status).toBe('forbidden');
    expect((await getMemoryForRequest('c', 'm1', { identity: identityDeps(), runtime: fakeRuntime({ getMemoryItem: () => Promise.resolve({ status: 'not_found' }) }) })).status).toBe('not_found');
  });

  test('delete (soft) propagates: memory_deleted / conflict / not_found / forbidden; account+actor server-resolved', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_mine', created: false }),
      deleteMemoryItem: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'ok', memoryItemId: 'mem_9' });
      },
    });
    expect(await deleteMemoryForRequest('co_d', 'mem_9', { identity: identityDeps(), runtime })).toEqual({ status: 'memory_deleted', memoryItemId: 'mem_9' });
    expect(calls).toEqual([{ userId: 'u1', accountId: 'acc_mine', companyId: 'co_d', memoryItemId: 'mem_9' }]);
    expect((await deleteMemoryForRequest('c', 'm1', { identity: identityDeps(), runtime: fakeRuntime({ deleteMemoryItem: () => Promise.resolve({ status: 'conflict' }) }) })).status).toBe('conflict');
    expect((await deleteMemoryForRequest('c', 'm1', { identity: identityDeps(), runtime: fakeRuntime({ deleteMemoryItem: () => Promise.resolve({ status: 'not_found' }) }) })).status).toBe('not_found');
    expect((await deleteMemoryForRequest('c', 'm1', { identity: identityDeps(), runtime: fakeRuntime({ deleteMemoryItem: () => Promise.resolve({ status: 'forbidden' }) }) })).status).toBe('forbidden');
  });

  test('unauthenticated / unverified refused on the memory endpoints', async () => {
    expect((await createMemoryForRequest('c', body, { identity: identityDeps({ userId: null }), runtime: fakeRuntime() })).status).toBe('unauthenticated');
    expect((await listMemoryForRequest('c', {}, { identity: identityDeps({ verified: false }), runtime: fakeRuntime() })).status).toBe('email_unverified');
    expect((await editMemoryForRequest('c', 'm1', { type: 'x', content: 'y', confidence: null }, { identity: identityDeps({ userId: null }), runtime: fakeRuntime() })).status).toBe('unauthenticated');
    expect((await deleteMemoryForRequest('c', 'm1', { identity: identityDeps({ verified: false }), runtime: fakeRuntime() })).status).toBe('email_unverified');
  });
});

/**
 * CDR-087 slice 1 — strategy read and decision recording at the request layer.
 *
 * THESE TESTS ASSERT MAPPING, NOT DTO SHAPE. The DTO's fields are core's contract and are tested there; what can
 * only go wrong HERE is the translation from a domain result union to a `CompaniesRequestResult` variant. So each
 * success case uses a SENTINEL object and asserts IDENTITY (`toBe`), which proves the request layer passed the
 * domain's value through untouched rather than rebuilding a lookalike.
 */
describe('CDR-087 — strategy read and decision recording (request layer)', () => {
  const GENERATION = { sentinel: 'generation' } as unknown as never;
  const SELECTION = { sentinel: 'selection' } as unknown as never;
  const DECISION = { sentinel: 'decision' } as unknown as never;

  describe('GET strategy — LatestStrategyResult has TWO arms (CDR-087 §5.0)', () => {
    test('an existing generation is passed through by identity', async () => {
      const runtime = fakeRuntime({ getLatestStrategy: () => Promise.resolve({ status: 'ok', generation: GENERATION }) });
      const r = await getStrategyForRequest('co_1', { runtime, identity: identityDeps() });
      expect(r.status).toBe('strategy');
      if (r.status !== 'strategy') return;
      expect(r.generation).toBe(GENERATION);
    });

    test('G9 — NO generation yet is a SUCCESS carrying null, never a not-found', async () => {
      // The company exists and the caller may read it; there is simply nothing generated. Mapping this to a
      // not-found is how a UI shows an error page on a normal first visit.
      const runtime = fakeRuntime({ getLatestStrategy: () => Promise.resolve({ status: 'ok', generation: null }) });
      const r = await getStrategyForRequest('co_1', { runtime, identity: identityDeps() });
      expect(r.status).toBe('strategy');
      if (r.status !== 'strategy') return;
      expect(r.generation).toBeNull();
    });

    test('forbidden maps to forbidden — the only other arm this result has', async () => {
      const runtime = fakeRuntime({ getLatestStrategy: () => Promise.resolve({ status: 'forbidden' }) });
      const r = await getStrategyForRequest('co_1', { runtime, identity: identityDeps() });
      expect(r.status).toBe('forbidden');
    });
  });

  describe('POST strategy selection — FOUR arms (CDR-087 §5.1)', () => {
    test('ok is passed through by identity', async () => {
      const runtime = fakeRuntime({ recordStrategySelection: () => Promise.resolve({ status: 'ok', selection: SELECTION }) });
      const r = await recordStrategySelectionForRequest('co_1', { generationId: 'gen_1', request: {} as never }, { runtime, identity: identityDeps() });
      expect(r.status).toBe('strategy_selected');
      if (r.status !== 'strategy_selected') return;
      expect(r.selection).toBe(SELECTION);
    });

    test.each([
      ['forbidden', 'forbidden'],
      ['not_found', 'not_found'],
      ['invalid', 'validation'],
    ])('the %s arm maps to %s, and G8 keeps forbidden and not_found DISTINCT', async (domain, mapped) => {
      const runtime = fakeRuntime({ recordStrategySelection: () => Promise.resolve({ status: domain } as never) });
      const r = await recordStrategySelectionForRequest('co_1', { generationId: 'gen_1', request: {} as never }, { runtime, identity: identityDeps() });
      expect(r.status).toBe(mapped);
    });
  });

  describe('POST decisions — FOUR arms (CDR-087 §5.1)', () => {
    test('ok is passed through by identity', async () => {
      const runtime = fakeRuntime({ recordDecision: () => Promise.resolve({ status: 'ok', decision: DECISION }) });
      const r = await recordDecisionForRequest('co_1', { generationId: 'gen_1', selectionId: 'sel_1' }, { runtime, identity: identityDeps() });
      expect(r.status).toBe('decision_recorded');
      if (r.status !== 'decision_recorded') return;
      expect(r.decision).toBe(DECISION);
    });

    test.each([
      ['forbidden', 'forbidden'],
      ['not_found', 'not_found'],
      ['invalid', 'validation'],
    ])('the %s arm maps to %s', async (domain, mapped) => {
      const runtime = fakeRuntime({ recordDecision: () => Promise.resolve({ status: domain } as never) });
      const r = await recordDecisionForRequest('co_1', { generationId: 'gen_1', selectionId: 'sel_1' }, { runtime, identity: identityDeps() });
      expect(r.status).toBe(mapped);
    });
  });

  describe('G3.1 — an unstubbed new surface FAILS LOUDLY', () => {
    test.each(['getLatestStrategy', 'recordStrategySelection', 'recordDecision'])(
      'the default %s throws rather than returning undefined',
      async (method) => {
        // A fixture that cannot produce the thing under test must fail loudly. Returning undefined here is how
        // ACBP-P6-007 hid two emergency-stop scopes that were enforcing nothing.
        const runtime = fakeRuntime();
        await expect((runtime as unknown as Record<string, () => Promise<unknown>>)[method]!()).rejects.toThrow(method);
      },
    );
  });
});
