// ACBP-P1-002 Slice 3 — authenticated read-through boundary tests (apps/web). Proves the internal-user
// lookup input comes ONLY from the P1-001 server-verified identity — forged browser headers/claims
// cannot influence it. Deterministic; injected deps (no Clerk, no database).
import { describe, test, expect } from 'vitest';
import type { VerifiedIdentityDeps } from '../auth/verified-identity.js';
import type { InternalUserReconciliation } from '@acbp/core';
import { resolveInternalUserForRequest } from './resolve-internal-user.js';

function identityDeps(over: Partial<{ userId: string | null; throws: boolean; verified: boolean }> = {}): VerifiedIdentityDeps {
  return {
    getUserId: () => (over.throws ? Promise.reject(new Error('session unavailable')) : Promise.resolve(over.userId === undefined ? 'user_verified' : over.userId)),
    getBackendUser: (userId) =>
      Promise.resolve({
        id: userId,
        primaryEmailAddressId: 'ema_1',
        emailAddresses: [{ id: 'ema_1', emailAddress: 'v@example.com', verification: { status: over.verified === false ? 'unverified' : 'verified' } }],
        firstName: null,
        lastName: null,
      }),
  };
}

describe('resolveInternalUserForRequest', () => {
  test('authenticated → reconciles using the SERVER-VERIFIED provider user id (never a header)', async () => {
    let seenId: string | undefined;
    const resolve = (providerUserId: string): Promise<InternalUserReconciliation> => {
      seenId = providerUserId;
      return Promise.resolve({ status: 'active', userId: 'internal-1' });
    };
    const result = await resolveInternalUserForRequest({ identity: identityDeps({ userId: 'user_verified' }), resolve });
    expect(result).toEqual({ status: 'active', userId: 'internal-1' });
    expect(seenId).toBe('user_verified'); // the only source is the verified session, not any request header
  });

  test('unauthenticated → does not reconcile (no provider/db lookup)', async () => {
    let called = false;
    const resolve = (): Promise<InternalUserReconciliation> => {
      called = true;
      return Promise.resolve({ status: 'not_found' });
    };
    await expect(resolveInternalUserForRequest({ identity: identityDeps({ userId: null }), resolve })).resolves.toEqual({ status: 'unauthenticated' });
    expect(called).toBe(false);
  });

  test('email_unverified → does not reconcile', async () => {
    await expect(resolveInternalUserForRequest({ identity: identityDeps({ verified: false }), resolve: () => Promise.resolve({ status: 'not_found' }) })).resolves.toEqual({
      status: 'email_unverified',
    });
  });

  test('session unavailable → session_unavailable (distinct from a reconciliation unavailable)', async () => {
    await expect(resolveInternalUserForRequest({ identity: identityDeps({ throws: true }), resolve: () => Promise.resolve({ status: 'not_found' }) })).resolves.toEqual({
      status: 'session_unavailable',
    });
  });

  test('a deleted mapping is surfaced (never resurrected here)', async () => {
    await expect(resolveInternalUserForRequest({ identity: identityDeps(), resolve: () => Promise.resolve({ status: 'deleted' }) })).resolves.toEqual({ status: 'deleted' });
  });
});
