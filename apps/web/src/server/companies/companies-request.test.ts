// ACBP-P1-010 — unit tests for the authenticated companies request use cases (injected deps; no Clerk/DB).
import { describe, test, expect } from 'vitest';
import { DECISION_ROOM_QUEUES, okSection, type DecisionRoomView } from '@acbp/contracts';
// ACBP-API-008 slice 3b: the factory core throws from when no model provider is configured. Imported rather than
// re-created, so this suite tests the CONTRACT between core's thrower and the web layer's recogniser.
import { modelGatewayNotConfiguredError } from '@acbp/core';
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
  getRoadmapForRequest,
  getTaskBoardForRequest,
  getTaskDetailForRequest,
  getArtifactForRequest,
  listRunArtifactsForRequest,
  readArtifactLineageForRequest,
  listApprovalInboxForRequest,
  editRoadmapForRequest,
  deleteTaskForRequest,
  generateStrategyForRequest,
  recommendStrategyForRequest,
  generateRoadmapForRequest,
  generateTasksForRequest,
  getTaskRunForRequest,
  listTaskRunsForRequest,
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
  type CompaniesRequestResult,
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

const COMPANY_VIEW = { companyId: 'co_1', status: 'active' as const, displayStatus: 'active' as const, name: 'Acme', description: null, profileVersion: 1, role: 'owner' as const };

function fakeRuntime(overrides: Partial<CompanyRuntime> = {}): CompanyRuntime {
  return {
    // ACBP-P7-013: REQUIRED on the runtime, so a fake cannot be admitted by omission (CDR-082 section 2).
    checkRequestLimit: () => Promise.resolve({ kind: 'allowed' } as const),
    // CDR-088 G3.1: the default REJECTS WITH THE METHOD NAME, so a test that reaches this path without stubbing
    // it fails saying which method it forgot, rather than passing on a silent undefined.
    getLatestRoadmap: () => Promise.reject(new Error('getLatestRoadmap was called without being stubbed')),
    getTaskBoard: () => Promise.reject(new Error('getTaskBoard was called without being stubbed')),
    getTaskDetail: () => Promise.reject(new Error('getTaskDetail was called without being stubbed')),
    getArtifact: () => Promise.reject(new Error('getArtifact was called without being stubbed')),
    listRunArtifacts: () => Promise.reject(new Error('listRunArtifacts was called without being stubbed')),
    readArtifactLineage: () => Promise.reject(new Error('readArtifactLineage was called without being stubbed')),
    listApprovalInbox: () => Promise.reject(new Error('listApprovalInbox was called without being stubbed')),
    editRoadmap: () => Promise.reject(new Error('editRoadmap was called without being stubbed')),
    deleteTask: () => Promise.reject(new Error('deleteTask was called without being stubbed')),
    getTaskRun: () => Promise.reject(new Error('getTaskRun was called without being stubbed')),
    listTaskRuns: () => Promise.reject(new Error('listTaskRuns was called without being stubbed')),
    // ACBP-API-008 slice 3b — THE FOUR METERED SURFACES. The unstubbed default rejects like every other, but the
    // stake is higher here: a fake that resolved `undefined` would let a test claim a generate path works while
    // the real one spends money, and these are the only four methods on this runtime that can.
    // CDR-092 §15: the fake is an admitted authenticated user. Default ALLOWED so existing mapping
    // tests keep testing mapping. Tests that need a refusal stub `forbidden` explicitly — that is
    // the whole point of the new ordering tests below.
    authorizeMeteredGenerate: () => Promise.resolve('allowed' as const),
    generateStrategyOptions: () => Promise.reject(new Error('generateStrategyOptions was called without being stubbed')),
    recommendStrategy: () => Promise.reject(new Error('recommendStrategy was called without being stubbed')),
    generateRoadmap: () => Promise.reject(new Error('generateRoadmap was called without being stubbed')),
    generateTasks: () => Promise.reject(new Error('generateTasks was called without being stubbed')),
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
/**
 * CDR-088 — the roadmap read. `LatestRoadmapResult` has the SAME two-arm shape as the strategy read:
 * `{ ok, roadmap: RoadmapDTO | null } | { forbidden }`. There is no `not_found` arm, so there is nothing here to
 * keep distinct from `forbidden` — the sub-resource granularity that CDR-087 §5.1 G8 cares about does not arise.
 */
/**
 * CDR-088 — the task board read. Two arms like the roadmap read, but the payload is NOT nullable:
 * `GetTaskBoardResult` carries a `TaskBoardDTO`, never null. An empty board is still a board, so the
 * absent-carrying-null case the roadmap read has does not arise here and is not invented for symmetry.
 */
/**
 * CDR-088 — task detail. THE FIRST SLICE-2 ROUTE WITH THREE ARMS: `GetTaskDetailResult` adds `not_found`, which
 * the roadmap and board reads do not have. That arm must stay DISTINCT from `forbidden` (§5): they answer at
 * different granularities — `forbidden` is the company-level refusal, `not_found` is the task-level one — and
 * collapsing them would throw away information the client needs to tell "not yours" from "not there".
 */
/**
 * CDR-088 §2.1a — the artifact reads, whose core use cases return BARE unions carrying string literals rather
 * than the tagged shape everything else here uses.
 *
 * THE FIRST TEST BELOW IS THE WHOLE SAFETY ARGUMENT FOR ADAPTING AT THIS LAYER. If the adapter ever stops
 * checking, `'forbidden'` is a perfectly good JSON value and would be serialized into a 200 body AS THE
 * ARTIFACT. No type error, no crash — a refusal rendered as content. Nothing else in this file needs a test
 * like this, because every other use case makes that state unrepresentable.
 */
/**
 * CDR-088 — the approvals inbox, the only slice-2 route whose core result carries a RAW DATABASE ROW
 * (`ApprovalRequestRow = Selectable<ApprovalRequestsTable>`) rather than a DTO. The request layer maps it to an
 * allowlisted `ApprovalInboxItem`, and the first test below is what makes that mapping trustworthy.
 */
/**
 * CDR-088 — the roadmap edit, the ONLY state-changing route in slice 2 and the only one with six result arms.
 * Three of them are refusals that must NOT collapse into one another: the caller's next move differs.
 */
/**
 * CDR-089 — the run read (ACBP-API-003). The FIRST route in this programme backed by a use case this programme
 * itself authored, rather than one that already existed: §0 of that CDR states the "no new domain logic" framing
 * of its two predecessors does NOT apply here.
 */
/**
 * ACBP-API-005 — task delete. Owner-only after the ACBP-API-004 narrowing, and the ONE genuinely pure-exposure
 * route in the held group: `deleteTask` takes no `deps` slot and makes no model call, unlike the four
 * metered-generation use cases held back for a CDR.
 */
describe('ACBP-API-005 — task delete (request layer)', () => {
  const base = { confirmed: true, reason: null };

  test('an UNCONFIRMED delete is refused, and the refusal is its OWN answer', async () => {
    // CDR-043 §4-G3 encodes "requires confirmation" as a required acknowledgement rather than a UI convention,
    // so it must survive the boundary as a distinct status — collapsing it into `validation` would let a client
    // retry blindly instead of asking the human.
    const runtime = fakeRuntime({ deleteTask: () => Promise.resolve({ status: 'confirmation_required' }) });
    const r = await deleteTaskForRequest('co_1', 'task_1', { confirmed: false, reason: null }, { runtime, identity: identityDeps() });
    expect(r.status).toBe('confirmation_required');
  });

  test('a successful delete reports the state it was in when deleted', async () => {
    const runtime = fakeRuntime({ deleteTask: () => Promise.resolve({ status: 'ok', taskId: 'task_1', stateAtDelete: 'planned' }) });
    const r = await deleteTaskForRequest('co_1', 'task_1', base, { runtime, identity: identityDeps() });
    expect(r.status).toBe('task_deleted');
    if (r.status !== 'task_deleted') return;
    expect(r.stateAtDelete).toBe('planned');
  });

  test('a mid-flight refusal carries its CLOSED reason, not a free-text message', async () => {
    const runtime = fakeRuntime({ deleteTask: () => Promise.resolve({ status: 'unavailable', reason: 'cancel_first' }) });
    const r = await deleteTaskForRequest('co_1', 'task_1', base, { runtime, identity: identityDeps() });
    expect(r.status).toBe('control_unavailable');
    if (r.status !== 'control_unavailable') return;
    expect(r.reason).toBe('cancel_first');
  });

  test('the owner reason is NEVER echoed back', async () => {
    const runtime = fakeRuntime({ deleteTask: () => Promise.resolve({ status: 'invalid' }) });
    const r = await deleteTaskForRequest('co_1', 'task_1', { confirmed: true, reason: 'SENSITIVE-OWNER-NOTE' }, { runtime, identity: identityDeps() });
    expect(JSON.stringify(r), 'the owner note must not come back in a refusal').not.toContain('SENSITIVE-OWNER-NOTE');
  });
});

describe('CDR-089 — run read (request layer)', () => {
  const RUN = { sentinel: 'run' } as unknown as never;

  test('the run is passed through by IDENTITY, not rebuilt', async () => {
    const runtime = fakeRuntime({ getTaskRun: () => Promise.resolve({ status: 'ok', run: RUN }) });
    const r = await getTaskRunForRequest('co_1', 'run_1', { runtime, identity: identityDeps() });
    expect(r.status).toBe('run');
    if (r.status !== 'run') return;
    expect(r.run).toBe(RUN);
  });

  test('not_found stays DISTINCT from forbidden', async () => {
    const missing = await getTaskRunForRequest('co_1', 'run_1', { runtime: fakeRuntime({ getTaskRun: () => Promise.resolve({ status: 'not_found' }) }), identity: identityDeps() });
    const denied = await getTaskRunForRequest('co_1', 'run_1', { runtime: fakeRuntime({ getTaskRun: () => Promise.resolve({ status: 'forbidden' }) }), identity: identityDeps() });
    expect(missing.status).toBe('not_found');
    expect(denied.status).toBe('forbidden');
  });

  test('the runId is FORWARDED, not dropped', async () => {
    // A boundary that discarded the selector would still answer 200 with SOMEONE's run.
    let seen: unknown;
    const runtime = fakeRuntime({ getTaskRun: (p) => { seen = p; return Promise.resolve({ status: 'ok', run: RUN }); } });
    await getTaskRunForRequest('co_1', 'run_42', { runtime, identity: identityDeps() });
    expect((seen as { runId?: string } | undefined)?.runId).toBe('run_42');
  });

  test('an EMPTY run list is a success — CDR-089 §3 forbids inventing a not_found here', async () => {
    // `listForTask` cannot tell an unknown task from a task with no runs, so this layer must not pretend it can.
    const runtime = fakeRuntime({ listTaskRuns: () => Promise.resolve({ status: 'ok', runs: [] }) });
    const r = await listTaskRunsForRequest('co_1', 'task_1', { runtime, identity: identityDeps() });
    expect(r.status).toBe('runs');
    if (r.status !== 'runs') return;
    expect(r.runs).toEqual([]);
  });
});

describe('CDR-088 — roadmap edit (request layer)', () => {
  const ROADMAP = { sentinel: 'roadmap' } as unknown as never;
  const body = { expectedRoadmapId: 'rm_1', plan: '{"goals":[]}', reason: 'because' };

  test('flaggedTaskCount travels WITH the roadmap — the consequence is not dropped', async () => {
    // ROAD-002 flags the tasks an edit invalidated. A client shown the new plan without the count would
    // under-report the effect of the owner's own edit.
    const runtime = fakeRuntime({ editRoadmap: () => Promise.resolve({ status: 'ok', roadmap: ROADMAP, flaggedTaskCount: 3 }) });
    const r = await editRoadmapForRequest('co_1', body, { runtime, identity: identityDeps() });
    expect(r.status).toBe('roadmap_edited');
    if (r.status !== 'roadmap_edited') return;
    expect(r.roadmap).toBe(ROADMAP);
    expect(r.flaggedTaskCount).toBe(3);
  });

  test('stale_version, decision_rejected, not_found and forbidden stay FOUR distinct answers', async () => {
    // Collapsing these would destroy what the caller does next: re-read and retry (stale), change the strategy
    // decision first (rejected), or stop (forbidden / not_found).
    const seen: string[] = [];
    for (const arm of ['stale_version', 'decision_rejected', 'not_found', 'forbidden'] as const) {
      const r = await editRoadmapForRequest('co_1', body, { runtime: fakeRuntime({ editRoadmap: () => Promise.resolve({ status: arm }) }), identity: identityDeps() });
      seen.push(r.status);
    }
    expect(seen).toEqual(['stale_version', 'decision_rejected', 'not_found', 'forbidden']);
    expect(new Set(seen).size, 'all four must remain distinguishable').toBe(4);
  });

  test('an invalid edit is a validation refusal that echoes no field of the submitted plan', async () => {
    const r = await editRoadmapForRequest('co_1', { ...body, plan: 'SENSITIVE-PLAN-CONTENT' }, { runtime: fakeRuntime({ editRoadmap: () => Promise.resolve({ status: 'invalid' }) }), identity: identityDeps() });
    expect(r.status).toBe('validation');
    expect(JSON.stringify(r), 'the submitted plan must not be echoed back').not.toContain('SENSITIVE-PLAN-CONTENT');
  });
});

describe('CDR-088 — approvals inbox (request layer)', () => {
  // A row carrying every column the real table has, plus a sentinel in each field that must NOT be published.
  const ROW = {
    id: 'apr_1',
    // Both NOT NULL in the table (migration 0048), so the fixture carries them.
    expires_at: '2026-08-19T12:00:00.000Z',
    created_at: '2026-08-18T09:00:00.000Z',
    account_id: 'acc_SECRET',
    company_id: 'co_SECRET',
    run_id: 'run_SECRET',
    policy_id: 'pol_SECRET',
    policy_version: 7,
    data: { secretPayload: 'SHOULD-NEVER-BE-SERVED' },
    tool_id: 'tool_1',
    tool_version: 2,
    action: 'send_email',
    reason: 'because',
    expected_result: 'an email',
    preview: 'To: someone',
    estimated_cost_credits: 5,
    // REAL values: migration 0047 CHECKs all three, and 'high'/'once' were impossible. A fixture carrying\n    // values the database cannot store is how ACBP-FE-016 shipped a risk map that matched no real row.\n    risk_class: 'sensitive_irreversible',
    reversibility: 'irreversible',
    scope: 'one_action',
  } as unknown as never;

  test('the wire shape is an ALLOWLIST: no internal column of the row is ever published', async () => {
    const r = await listApprovalInboxForRequest('co_1', { runtime: fakeRuntime({ listApprovalInbox: () => Promise.resolve({ status: 'ok', requests: [ROW] }) }), identity: identityDeps() });
    expect(r.status).toBe('approvals');
    if (r.status !== 'approvals') return;

    const serialized = JSON.stringify(r);
    // The raw tool payload is the highest-risk column on this table and must never appear in any form.
    expect(serialized, 'the raw `data` payload must never be served').not.toContain('SHOULD-NEVER-BE-SERVED');
    for (const secret of ['acc_SECRET', 'co_SECRET', 'run_SECRET', 'pol_SECRET']) {
      expect(serialized, `${secret} is internal and must not be published`).not.toContain(secret);
    }
    // And positively: the item carries EXACTLY the allowlisted keys, so a new column cannot arrive unnoticed.
    expect(Object.keys(r.approvals[0] ?? {}).sort()).toEqual(
      ['action', 'approvalRequestId', 'createdAt', 'estimatedCostCredits', 'expectedResult', 'expiresAt', 'preview', 'reason', 'reversibility', 'riskClass', 'scope', 'toolId', 'toolVersion'],
    );
  });

  test('an UNREADABLE timestamp degrades to the raw value instead of failing the whole read', async () => {
    // `new Date(x).toISOString()` throws RangeError, and this mapping runs inside a `.map` over every row —
    // so one odd value would turn the entire inbox into a 500 rather than one odd card. Both columns are NOT
    // NULL, so this should not arise; "should not" is not an enforcer, and the blast radius of being wrong
    // here is the whole page. The client has an `unreadable` state that refuses to treat it as valid.
    const bad = { ...(ROW as unknown as Record<string, unknown>), expires_at: 'not-a-date' } as unknown as never;
    const r = await listApprovalInboxForRequest('co_1', { runtime: fakeRuntime({ listApprovalInbox: () => Promise.resolve({ status: 'ok', requests: [bad] }) }), identity: identityDeps() });
    expect(r.status).toBe('approvals');
    if (r.status !== 'approvals') return;
    expect(r.approvals[0]?.expiresAt).toBe('not-a-date');
  });
  test('a refusal carries no payload', async () => {
    const r = await listApprovalInboxForRequest('co_1', { runtime: fakeRuntime({ listApprovalInbox: () => Promise.resolve({ status: 'forbidden' }) }), identity: identityDeps() });
    expect(r.status).toBe('forbidden');
    expect(Object.keys(r)).toEqual(['status']);
  });
});

describe('CDR-088 — artifact reads (request layer)', () => {
  const ARTIFACT = { sentinel: 'artifact' } as unknown as never;

  test('EVERY refusal STRING maps to a refusal and never reaches a success payload', async () => {
    for (const refusal of ['forbidden', 'not_found'] as const) {
      const r = await getArtifactForRequest('co_1', 'art_1', { runtime: fakeRuntime({ getArtifact: () => Promise.resolve(refusal) }), identity: identityDeps() });
      expect(r.status, `${refusal} must map to a refusal`).toBe(refusal);
      expect(JSON.stringify(r), `${refusal} must not appear as an artifact payload`).not.toContain('"artifact"');
    }
    const listed = await listRunArtifactsForRequest('co_1', 'run_1', { runtime: fakeRuntime({ listRunArtifacts: () => Promise.resolve('forbidden') }), identity: identityDeps() });
    expect(listed.status).toBe('forbidden');
    expect(JSON.stringify(listed)).not.toContain('"artifacts"');
  });

  test('an artifact is passed through by IDENTITY, not rebuilt', async () => {
    const r = await getArtifactForRequest('co_1', 'art_1', { runtime: fakeRuntime({ getArtifact: () => Promise.resolve(ARTIFACT) }), identity: identityDeps() });
    expect(r.status).toBe('artifact');
    if (r.status !== 'artifact') return;
    expect(r.artifact).toBe(ARTIFACT);
  });

  test('an EMPTY artifact list is a success, not a not-found — an unknown run and an empty run agree', async () => {
    // §2.1a: listRunArtifacts has no not_found arm, so this layer must not invent one.
    const r = await listRunArtifactsForRequest('co_1', 'run_1', { runtime: fakeRuntime({ listRunArtifacts: () => Promise.resolve([]) }), identity: identityDeps() });
    expect(r.status).toBe('artifacts');
    if (r.status !== 'artifacts') return;
    expect(r.artifacts).toEqual([]);
  });

  test('lineage is tagged, so not_found stays distinct from forbidden', async () => {
    // Core names this arm `artifact_not_found`; the boundary normalizes it to `not_found`. Asserting the CORE
    // name here is deliberate — it fails if that mapping is ever dropped.
    const missing = await readArtifactLineageForRequest('co_1', 'art_1', { runtime: fakeRuntime({ readArtifactLineage: () => Promise.resolve({ status: 'artifact_not_found' }) }), identity: identityDeps() });
    const denied = await readArtifactLineageForRequest('co_1', 'art_1', { runtime: fakeRuntime({ readArtifactLineage: () => Promise.resolve({ status: 'forbidden' }) }), identity: identityDeps() });
    expect(missing.status).toBe('not_found');
    expect(denied.status).toBe('forbidden');
  });
});

describe('CDR-088 — task detail (request layer)', () => {
  const TASK = { sentinel: 'task' } as unknown as never;

  test('the task is passed through by IDENTITY, not rebuilt', async () => {
    const runtime = fakeRuntime({ getTaskDetail: () => Promise.resolve({ status: 'ok', task: TASK }) });
    const r = await getTaskDetailForRequest('co_1', 'task_1', { runtime, identity: identityDeps() });
    expect(r.status).toBe('task');
    if (r.status !== 'task') return;
    expect(r.task).toBe(TASK);
  });

  test('not_found stays DISTINCT from forbidden — they are not the same answer', async () => {
    const missing = await getTaskDetailForRequest('co_1', 'task_1', { runtime: fakeRuntime({ getTaskDetail: () => Promise.resolve({ status: 'not_found' }) }), identity: identityDeps() });
    const denied = await getTaskDetailForRequest('co_1', 'task_1', { runtime: fakeRuntime({ getTaskDetail: () => Promise.resolve({ status: 'forbidden' }) }), identity: identityDeps() });
    expect(missing.status).toBe('not_found');
    expect(denied.status).toBe('forbidden');
    expect(missing.status).not.toBe(denied.status);
  });

  test('the taskId is forwarded, not dropped', async () => {
    // A boundary that silently discarded the selector would still return 200 with SOMEONE's task.
    let seen: unknown;
    const runtime = fakeRuntime({ getTaskDetail: (p) => { seen = p; return Promise.resolve({ status: 'ok', task: TASK }); } });
    await getTaskDetailForRequest('co_1', 'task_42', { runtime, identity: identityDeps() });
    expect((seen as { taskId?: string } | undefined)?.taskId).toBe('task_42');
  });
});

describe('CDR-088 — task board read (request layer)', () => {
  const BOARD = { sentinel: 'board' } as unknown as never;

  test('the board is passed through by IDENTITY, not rebuilt', async () => {
    const runtime = fakeRuntime({ getTaskBoard: () => Promise.resolve({ status: 'ok', board: BOARD }) });
    const r = await getTaskBoardForRequest('co_1', { runtime, identity: identityDeps() });
    expect(r.status).toBe('tasks');
    if (r.status !== 'tasks') return;
    expect(r.board).toBe(BOARD);
  });

  test('a refusal maps to forbidden and carries no payload', async () => {
    const runtime = fakeRuntime({ getTaskBoard: () => Promise.resolve({ status: 'forbidden' }) });
    const r = await getTaskBoardForRequest('co_1', { runtime, identity: identityDeps() });
    expect(r.status).toBe('forbidden');
    expect(Object.keys(r)).toEqual(['status']);
  });
});

describe('CDR-088 — roadmap read (request layer)', () => {
  const ROADMAP = { sentinel: 'roadmap' } as unknown as never;

  test('an existing roadmap is passed through by IDENTITY, not rebuilt', async () => {
    const runtime = fakeRuntime({ getLatestRoadmap: () => Promise.resolve({ status: 'ok', roadmap: ROADMAP }) });
    const r = await getRoadmapForRequest('co_1', { runtime, identity: identityDeps() });
    expect(r.status).toBe('roadmap');
    if (r.status !== 'roadmap') return;
    expect(r.roadmap).toBe(ROADMAP);
  });

  test('NO roadmap yet is a SUCCESS carrying null, never a not-found (CDR-088 §5)', async () => {
    // Same reasoning as the strategy read's G9: the company exists and the caller may read it, there is simply
    // nothing planned yet. A 404 here is how a UI shows an error page on a normal first visit.
    const runtime = fakeRuntime({ getLatestRoadmap: () => Promise.resolve({ status: 'ok', roadmap: null }) });
    const r = await getRoadmapForRequest('co_1', { runtime, identity: identityDeps() });
    expect(r.status).toBe('roadmap');
    if (r.status !== 'roadmap') return;
    expect(r.roadmap).toBeNull();
  });

  test('a refusal maps to forbidden and carries no payload', async () => {
    const runtime = fakeRuntime({ getLatestRoadmap: () => Promise.resolve({ status: 'forbidden' }) });
    const r = await getRoadmapForRequest('co_1', { runtime, identity: identityDeps() });
    expect(r.status).toBe('forbidden');
    expect(Object.keys(r)).toEqual(['status']);
  });
});

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

/**
 * ACBP-API-008 slice 3b — the four routes that spend real money (CDR-092).
 *
 * Everything else in this file guards a read or a database write. These four cause a PAID provider call, so the
 * question each test below asks is not "is the answer shaped right" but "can money leave when it should not".
 *
 * CDR-092 §11 records why the enforcement proof lives HERE rather than in an AST check: a route can branch on
 * the limiter's outcome and still call the use case in both arms, satisfying any structural matcher while the
 * spend happens anyway. The property that actually matters is behavioural and is asserted directly — when the
 * ceiling refuses, the metered method is NEVER INVOKED. `neverCalled` below is the whole guard.
 */
describe('ACBP-API-008 slice 3b — the four metered generate surfaces (request layer)', () => {
  const GENERATION = { sentinel: 'generation' } as unknown as never;
  const RECOMMENDATION = { sentinel: 'recommendation' } as unknown as never;
  const ROADMAP = { sentinel: 'roadmap' } as unknown as never;
  const TASKS = [{ sentinel: 'task' }] as unknown as never;

  const OK_TASKS = { status: 'ok', tasks: TASKS, partial: false, tasksMissingType: 0, milestonesOmitted: 0, tasksMissingRationale: 0, memoryItemsConsidered: 4 } as const;

  type Deps = { readonly runtime: CompanyRuntime; readonly identity: VerifiedIdentityDeps };

  /**
   * One row per metered surface. Driving all four from one table is deliberate: every assertion below then runs
   * against every metered surface, so a guard proven for `strategy:generate` is proven for the other three too.
   *
   * WHAT THE COUNT ASSERTION AT THE END OF THIS BLOCK IS NOT. It used to be described here as what makes a fifth
   * generate route fail rather than pass silently. It cannot be: `METERED` is a literal in this file, so a fifth
   * route changes nothing about it and the count still sees four. It can only fail if somebody edits this table,
   * which means they already remembered — the assurance was circular, and a comment that hands the next reader a
   * guarantee that does not exist is worse than no comment. The check that actually enumerates is
   * `tools/check-generate-route-coverage.mjs`, which walks the filesystem and additionally fails on any request
   * function that reaches a paid runtime method without the ceiling. The count stays as a cheap guard against
   * someone deleting a row from this table.
   */
  const METERED: readonly {
    readonly label: string;
    readonly method: 'generateStrategyOptions' | 'recommendStrategy' | 'generateRoadmap' | 'generateTasks';
    readonly ok: Partial<CompanyRuntime>;
    readonly okStatus: string;
    readonly call: (deps: Deps) => Promise<CompaniesRequestResult>;
  }[] = [
    {
      label: 'strategy:generate',
      method: 'generateStrategyOptions',
      ok: { generateStrategyOptions: () => Promise.resolve({ status: 'ok', generation: GENERATION }) },
      okStatus: 'strategy_generated',
      call: (deps) => generateStrategyForRequest('co_1', deps),
    },
    {
      label: 'strategy:recommend',
      method: 'recommendStrategy',
      ok: { recommendStrategy: () => Promise.resolve({ status: 'ok', recommendation: RECOMMENDATION }) },
      okStatus: 'strategy_recommended',
      call: (deps) => recommendStrategyForRequest('co_1', { generationId: 'gen_1' }, deps),
    },
    {
      label: 'roadmap:generate',
      method: 'generateRoadmap',
      ok: { generateRoadmap: () => Promise.resolve({ status: 'ok', roadmap: ROADMAP }) },
      okStatus: 'roadmap_generated',
      call: (deps) => generateRoadmapForRequest('co_1', deps),
    },
    {
      label: 'task:generate',
      method: 'generateTasks',
      ok: { generateTasks: () => Promise.resolve(OK_TASKS) },
      okStatus: 'tasks_generated',
      call: (deps) => generateTasksForRequest('co_1', deps),
    },
  ];

  /** A stub for the metered method that FAILS THE TEST if it is ever reached. */
  function neverCalled(method: string): Partial<CompanyRuntime> {
    const boom = (): Promise<never> => Promise.reject(new Error(`SPENT MONEY: ${method} was invoked after the ceiling refused`));
    return { [method]: boom };
  }

  test.each(METERED.map((m) => [m.label, m] as const))(
    '%s — a FORBIDDEN caller leaves the company bucket untouched',
    async (_label, m) => {
      // CDR-092 §15. A test that FAILS if the bucket moves: company is counted, authorize returns
      // forbidden, and any company-scoped consume reddens. Session/account must still appear —
      // those scopes are the stranger's volume control, and this test is also the verification
      // that they apply to a non-member request.
      const seen: { scope: string; key: string }[] = [];
      const runtime = fakeRuntime({
        authorizeMeteredGenerate: () => Promise.resolve('forbidden' as const),
        checkRequestLimit: (scopeKind: string, scopeKey: string) => {
          seen.push({ scope: scopeKind, key: scopeKey });
          return Promise.resolve({ kind: 'allowed' } as const);
        },
        ...neverCalled(m.method),
      });
      const r = await m.call({ runtime, identity: identityDeps() });
      expect(r.status).toBe('forbidden');
      expect(seen, 'the account ceiling must still bind a refused caller').toContainEqual({ scope: 'account', key: 'acc_1' });
      expect(
        seen.filter((s) => s.scope === 'company'),
        'a forbidden request that moved the company bucket is the drain this ruling closed',
      ).toEqual([]);
    },
  );

  test.each(METERED.map((m) => [m.label, m] as const))(
    '%s — an authorized owner still debits the company bucket',
    async (_label, m) => {
      // The other direction: a reorder that exempts everyone would make the forbidden test pass
      // and silently uncap legitimate traffic. This fails if company is missing from `seen`.
      const seen: { scope: string; key: string }[] = [];
      const runtime = fakeRuntime({
        authorizeMeteredGenerate: () => Promise.resolve('allowed' as const),
        checkRequestLimit: (scopeKind: string, scopeKey: string) => {
          seen.push({ scope: scopeKind, key: scopeKey });
          return Promise.resolve({ kind: 'allowed' } as const);
        },
        ...m.ok,
      });
      const r = await m.call({ runtime, identity: identityDeps() });
      expect(r.status).toBe(m.okStatus);
      expect(seen).toContainEqual({ scope: 'account', key: 'acc_1' });
      expect(seen).toContainEqual({ scope: 'company', key: 'co_1' });
    },
  );

  test.each(METERED.map((m) => [m.label, m] as const))(
    '%s — an unauthenticated caller never reaches authorize or the company bucket',
    async (_label, m) => {
      const seen: string[] = [];
      const runtime = fakeRuntime({
        authorizeMeteredGenerate: () => {
          seen.push('authorize');
          return Promise.resolve('allowed' as const);
        },
        checkRequestLimit: (scopeKind: string) => {
          seen.push(scopeKind);
          return Promise.resolve({ kind: 'allowed' } as const);
        },
        ...neverCalled(m.method),
      });
      const r = await m.call({ runtime, identity: identityDeps({ userId: null }) });
      expect(r.status).toBe('unauthenticated');
      expect(seen).toEqual([]);
    },
  );

  test.each(METERED.map((m) => [m.label, m] as const))(
    '%s — a THROTTLED company ceiling refuses BEFORE the model is reached',
    async (_label, m) => {
      // The guard CDR-092 §6.2 names: "a limiter that is called but whose result is ignored is the exact shape of
      // ACBP-P6-010's shipped-but-unread spend ceiling". Ignoring the outcome here reaches `boom` and reddens.
      const runtime = fakeRuntime({
        checkRequestLimit: (scopeKind: string) =>
          Promise.resolve(scopeKind === 'company' ? ({ kind: 'throttled', retryAfterSeconds: 12 } as const) : ({ kind: 'allowed' } as const)),
        ...neverCalled(m.method),
      } as Partial<CompanyRuntime>);
      const r = await m.call({ runtime, identity: identityDeps() });
      expect(r.status).toBe('rate_limited');
      if (r.status !== 'rate_limited') return;
      expect(r.retryAfterSeconds).toBe(12);
    },
  );

  test.each(METERED.map((m) => [m.label, m] as const))(
    '%s — an UNREADABLE bucket fails CLOSED, and still never reaches the model',
    async (_label, m) => {
      // CDR-092 §2: the limiter reports `unavailable` rather than lying about WHY. Fail-open here would mean an
      // unreadable bucket becomes unlimited paid calls — the worst direction for this particular guard to fail.
      const runtime = fakeRuntime({
        checkRequestLimit: (scopeKind: string) => Promise.resolve(scopeKind === 'company' ? ({ kind: 'unavailable' } as const) : ({ kind: 'allowed' } as const)),
        ...neverCalled(m.method),
      });
      const r = await m.call({ runtime, identity: identityDeps() });
      expect(r.status).toBe('unavailable');
    },
  );

  test.each(METERED.map((m) => [m.label, m] as const))('%s — the happy path maps to its own arm', async (_label, m) => {
    const r = await m.call({ runtime: fakeRuntime(m.ok), identity: identityDeps() });
    expect(r.status).toBe(m.okStatus);
  });

  test.each(METERED.map((m) => [m.label, m] as const))(
    '%s — the COMPANY ceiling is keyed on the company, not the account',
    async (_label, m) => {
      // A company-scoped ceiling keyed on the account id would throttle a founder's second company because their
      // first one was busy, and would let one company consume the ceiling of another. The key is the distinguishing
      // fact of this scope, so it is asserted rather than assumed.
      const seen: { scope: string; key: string }[] = [];
      const runtime = fakeRuntime({
        checkRequestLimit: (scopeKind: string, scopeKey: string) => {
          seen.push({ scope: scopeKind, key: scopeKey });
          return Promise.resolve({ kind: 'allowed' } as const);
        },
        ...m.ok,
      });
      await m.call({ runtime, identity: identityDeps() });
      expect(seen, 'the account ceiling must still apply — the company one is IN ADDITION, not INSTEAD').toContainEqual({ scope: 'account', key: 'acc_1' });
      expect(seen).toContainEqual({ scope: 'company', key: 'co_1' });
    },
  );

  test.each(METERED.map((m) => [m.label, m] as const))('%s — a core `forbidden` is forwarded as an opaque refusal', async (_label, m) => {
    // The request layer makes NO authorization decision (CDR-088 §1; CDR-092 §11). What it must not do is absorb
    // one: a forbidden that arrived as a 200 would be a viewer spending an owner's budget.
    const runtime = fakeRuntime({ [m.method]: () => Promise.resolve({ status: 'forbidden' }) });
    const r = await m.call({ runtime, identity: identityDeps() });
    expect(r.status).toBe('forbidden');
  });

  test('the metered table still has its four rows — a deleted row fails here', () => {
    // Guards the table above against a row being dropped, which would silently stop testing a live surface. It
    // does NOT notice a fifth route: see the note on METERED for why that claim was wrong, and
    // tools/check-generate-route-coverage.mjs for the check that does walk the filesystem.
    expect(METERED).toHaveLength(4);
  });

  describe('each surface keeps its own refusal vocabulary — collapsing them destroys the next move', () => {
    test('strategy:generate — five arms stay distinct', async () => {
      const seen: string[] = [];
      for (const arm of ['forbidden', 'no_understanding', 'not_confirmed', 'stale_understanding', 'generation_failed'] as const) {
        const runtime = fakeRuntime({ generateStrategyOptions: () => Promise.resolve({ status: arm } as never) });
        seen.push((await generateStrategyForRequest('co_1', { runtime, identity: identityDeps() })).status);
      }
      expect(seen).toEqual(['forbidden', 'no_understanding', 'not_confirmed', 'stale_understanding', 'generation_failed']);
      expect(new Set(seen).size).toBe(5);
    });

    test('strategy:recommend — a missing generation is not_found, a failed model is not', async () => {
      const seen: string[] = [];
      for (const arm of ['forbidden', 'not_found', 'recommendation_failed'] as const) {
        const runtime = fakeRuntime({ recommendStrategy: () => Promise.resolve({ status: arm } as never) });
        seen.push((await recommendStrategyForRequest('co_1', { generationId: 'gen_1' }, { runtime, identity: identityDeps() })).status);
      }
      expect(seen).toEqual(['forbidden', 'not_found', 'recommendation_failed']);
    });

    test('strategy:recommend — a NULL recommendation is a success, not an absence', async () => {
      // The core arm is `recommendation: StrategyRecommendationDTO | null`. Mapping null to 404 would tell the
      // caller the generation does not exist, which is a different and false statement.
      const runtime = fakeRuntime({ recommendStrategy: () => Promise.resolve({ status: 'ok', recommendation: null }) });
      const r = await recommendStrategyForRequest('co_1', { generationId: 'gen_1' }, { runtime, identity: identityDeps() });
      expect(r.status).toBe('strategy_recommended');
      if (r.status !== 'strategy_recommended') return;
      expect(r.recommendation).toBeNull();
    });

    test('roadmap:generate — five arms stay distinct', async () => {
      const seen: string[] = [];
      for (const arm of ['forbidden', 'no_decision', 'decision_rejected', 'stale_decision', 'generation_failed'] as const) {
        const runtime = fakeRuntime({ generateRoadmap: () => Promise.resolve({ status: arm } as never) });
        seen.push((await generateRoadmapForRequest('co_1', { runtime, identity: identityDeps() })).status);
      }
      expect(seen).toEqual(['forbidden', 'no_decision', 'decision_rejected', 'stale_decision', 'generation_failed']);
      expect(new Set(seen).size).toBe(5);
    });

    test('task:generate — all EIGHT planning arms stay distinct', async () => {
      const arms = ['forbidden', 'no_decision', 'decision_rejected', 'no_roadmap', 'no_milestones_in_scope', 'stale_decision', 'stale_roadmap', 'generation_failed'] as const;
      const seen: string[] = [];
      for (const arm of arms) {
        const runtime = fakeRuntime({ generateTasks: () => Promise.resolve({ status: arm } as never) });
        seen.push((await generateTasksForRequest('co_1', { runtime, identity: identityDeps() })).status);
      }
      expect(new Set(seen).size, 'eight refusals, eight answers — "planning failure is visible with reason"').toBe(8);
    });

    test('task:generate — a PARTIAL plan reports its shortfall rather than presenting as complete', async () => {
      // ADR-019/TASK-002 forbid inventing a task type, so a shortfall is reported. Dropping these counters at the
      // request layer would restore exactly the fabricated-completeness the domain refuses to produce.
      const runtime = fakeRuntime({ generateTasks: () => Promise.resolve({ ...OK_TASKS, partial: true, tasksMissingType: 2, milestonesOmitted: 1, tasksMissingRationale: 3 }) });
      const r = await generateTasksForRequest('co_1', { runtime, identity: identityDeps() });
      expect(r.status).toBe('tasks_generated');
      if (r.status !== 'tasks_generated') return;
      expect({ partial: r.partial, missingType: r.tasksMissingType, omitted: r.milestonesOmitted, missingRationale: r.tasksMissingRationale }).toEqual({
        partial: true,
        missingType: 2,
        omitted: 1,
        missingRationale: 3,
      });
    });
  });

  test.each(METERED.map((m) => [m.label, m] as const))(
    '%s — an unconfigured model gateway is a bounded 503, and never names the credential',
    async (_label, m) => {
      // CDR-092 §9 has the runtime THROW when no provider is configured. Unmapped, that throw becomes the generic
      // 500 — indistinguishable from a bug, on the one failure an operator can actually fix.
      //
      // The rejection is built with CORE'S OWN factory rather than a hand-written Error carrying the right text.
      // A string literal here would keep passing after core changed how it signals this, which is the difference
      // between testing the contract and testing my copy of it.
      const runtime = fakeRuntime({ [m.method]: () => Promise.reject(modelGatewayNotConfiguredError()) });
      const r = await m.call({ runtime, identity: identityDeps() });
      expect(r.status).toBe('unavailable');
      expect(JSON.stringify(r), 'the thrown text names an environment variable — it must not travel').not.toContain('ANTHROPIC_API_KEY');
      expect(JSON.stringify(r)).not.toContain('MODEL_GATEWAY_NOT_CONFIGURED');
    },
  );

  test.each(METERED.map((m) => [m.label, m] as const))('%s — any OTHER throw stays a 500, and is not disguised as unavailable', async (_label, m) => {
    // The catch above must recognise ONE condition, not swallow the class. A bug that reported itself as 503
    // would read as "the platform is briefly down" forever, and nobody would look for it.
    const runtime = fakeRuntime({ [m.method]: () => Promise.reject(new TypeError('genuine defect')) });
    await expect(m.call({ runtime, identity: identityDeps() })).rejects.toThrow('genuine defect');
  });
});
