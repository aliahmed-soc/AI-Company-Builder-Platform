// ACBP-P1-003 — unit tests for the authenticated profile request use cases (injected deps; no Clerk/DB).
import { describe, test, expect } from 'vitest';
import { validationError, type PublicErrorEnvelope } from '@acbp/contracts';
import type { AccountProfileView, InternalUserReconciliation, ProfileUpdateInput, ProvisionResult } from '@acbp/core';
import { getAccountProfileForRequest, updateAccountProfileForRequest, type AccountOps, type ProfileRequestDeps } from './profile-request.js';

const VIEW: AccountProfileView = { accountId: 'acc_1', displayName: 'Ada', locale: 'en', email: 'a@b.com', emailVerified: true };

/** Identity deps that authenticate a verified user, then resolve to the given reconciliation outcome. */
function identityDeps(resolution: InternalUserReconciliation): ProfileRequestDeps['identity'] {
  return {
    identity: {
      getUserId: () => Promise.resolve('clerk_1'),
      // ACBP-P7-013: both REQUIRED, never defaulted — a limiter that defaults to allowed is the
      // P6-007 stop-port defect (CDR-072 section 1-G1). A test that wants to be admitted says so.
      getSessionId: () => Promise.resolve('sess_test'),
      checkSessionLimit: () => Promise.resolve({ kind: 'allowed' } as const),
      getBackendUser: () =>
        Promise.resolve({
          id: 'clerk_1',
          primaryEmailAddressId: 'e1',
          emailAddresses: [{ id: 'e1', emailAddress: 'a@b.com', verification: { status: 'verified' } }],
          firstName: null,
          lastName: null,
        }),
    },
    resolve: () => Promise.resolve(resolution),
  };
}

function fakeAccounts(overrides: Partial<AccountOps> = {}): { ops: AccountOps; calls: { ensured: string[]; updated: { userId: string; input: ProfileUpdateInput }[] } } {
  const calls = { ensured: [] as string[], updated: [] as { userId: string; input: ProfileUpdateInput }[] };
  const ops: AccountOps = {
    // ACBP-P7-013: REQUIRED on the runtime, so a fake cannot be admitted by omission (CDR-082 section 2).
    checkRequestLimit: () => Promise.resolve({ kind: 'allowed' } as const),

    ensurePersonalAccount: (userId: string): Promise<ProvisionResult> => {
      calls.ensured.push(userId);
      return Promise.resolve({ accountId: 'acc_1', created: true });
    },
    getAccountProfile: () => Promise.resolve(VIEW),
    updateAccountProfile: (userId: string, input: ProfileUpdateInput) => {
      calls.updated.push({ userId, input });
      return Promise.resolve(VIEW);
    },
    ...overrides,
  };
  return { ops, calls };
}

describe('getAccountProfileForRequest', () => {
  test('unauthenticated request → unauthenticated (no account touched)', async () => {
    const { ops, calls } = fakeAccounts();
    const r = await getAccountProfileForRequest({ identity: { identity: { getUserId: () => Promise.resolve(null), getSessionId: () => Promise.resolve('sess_test'), checkSessionLimit: () => Promise.resolve({ kind: 'allowed' } as const), getBackendUser: () => Promise.reject(new Error('unused')) } }, accounts: ops });
    expect(r.status).toBe('unauthenticated');
    expect(calls.ensured).toEqual([]);
  });

  test('deleted identity → forbidden', async () => {
    const { ops } = fakeAccounts();
    const r = await getAccountProfileForRequest({ identity: identityDeps({ status: 'deleted' }), accounts: ops });
    expect(r.status).toBe('forbidden');
  });

  test('reconciliation unavailable → unavailable', async () => {
    const err: PublicErrorEnvelope = { category: 'provider_unavailable', code: 'DEPENDENCY_UNAVAILABLE', message: 'x', retryable: true };
    const { ops } = fakeAccounts();
    const r = await getAccountProfileForRequest({ identity: identityDeps({ status: 'unavailable', error: err }), accounts: ops });
    expect(r.status).toBe('unavailable');
  });

  test('active user → ensures the account and returns the profile', async () => {
    const { ops, calls } = fakeAccounts();
    const r = await getAccountProfileForRequest({ identity: identityDeps({ status: 'active', userId: 'usr_1' }), accounts: ops });
    expect(r).toEqual({ status: 'ok', profile: VIEW });
    expect(calls.ensured).toEqual(['usr_1']); // provisioned on first sign-in
  });

  test('active user but profile missing → not_found', async () => {
    const { ops } = fakeAccounts({ getAccountProfile: () => Promise.resolve(undefined) });
    const r = await getAccountProfileForRequest({ identity: identityDeps({ status: 'active', userId: 'usr_1' }), accounts: ops });
    expect(r.status).toBe('not_found');
  });

  test('missing internal-user mapping → not_found (no account touched) — ACBP-P1-007', async () => {
    const { ops, calls } = fakeAccounts();
    const r = await getAccountProfileForRequest({ identity: identityDeps({ status: 'not_found' }), accounts: ops });
    expect(r.status).toBe('not_found');
    expect(calls.ensured).toEqual([]);
  });
});

describe('updateAccountProfileForRequest', () => {
  test('active user → ensures account, applies edit, returns view', async () => {
    const { ops, calls } = fakeAccounts();
    const r = await updateAccountProfileForRequest({ displayName: 'Grace' }, { identity: identityDeps({ status: 'active', userId: 'usr_1' }), accounts: ops });
    expect(r).toEqual({ status: 'ok', profile: VIEW });
    expect(calls.ensured).toEqual(['usr_1']);
    expect(calls.updated).toEqual([{ userId: 'usr_1', input: { displayName: 'Grace' } }]);
  });

  test('a domain validation error becomes a safe 400 envelope', async () => {
    const { ops } = fakeAccounts({
      updateAccountProfile: () => Promise.reject(validationError({ message: 'Locale is not a valid language tag.', fields: ['locale'] })),
    });
    const r = await updateAccountProfileForRequest({ locale: 'nope!' }, { identity: identityDeps({ status: 'active', userId: 'usr_1' }), accounts: ops });
    expect(r.status).toBe('validation_error');
    if (r.status === 'validation_error') {
      expect(r.error.category).toBe('validation');
      // The public envelope carries no field values or internals.
      expect(JSON.stringify(r.error)).not.toContain('nope');
    }
  });

  test('unauthenticated update → unauthenticated (no write)', async () => {
    const { ops, calls } = fakeAccounts();
    const r = await updateAccountProfileForRequest({ displayName: 'X' }, { identity: { identity: { getUserId: () => Promise.resolve(null), getSessionId: () => Promise.resolve('sess_test'), checkSessionLimit: () => Promise.resolve({ kind: 'allowed' } as const), getBackendUser: () => Promise.reject(new Error('unused')) } }, accounts: ops });
    expect(r.status).toBe('unauthenticated');
    expect(calls.updated).toEqual([]);
  });

  test('deleted identity → forbidden (no write) — ACBP-P1-007', async () => {
    const { ops, calls } = fakeAccounts();
    const r = await updateAccountProfileForRequest({ displayName: 'X' }, { identity: identityDeps({ status: 'deleted' }), accounts: ops });
    expect(r.status).toBe('forbidden');
    expect(calls.updated).toEqual([]);
  });

  test('missing internal-user mapping → not_found (no write) — ACBP-P1-007', async () => {
    const { ops, calls } = fakeAccounts();
    const r = await updateAccountProfileForRequest({ displayName: 'X' }, { identity: identityDeps({ status: 'not_found' }), accounts: ops });
    expect(r.status).toBe('not_found');
    expect(calls.updated).toEqual([]);
  });
});
