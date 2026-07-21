// ACBP-P1-004 — unit tests for the authenticated members request use cases (injected deps; no Clerk/DB).
import { describe, test, expect } from 'vitest';
import type { VerifiedIdentityDeps } from '../auth/verified-identity.js';
import { listMembersForRequest, inviteMemberForRequest, acceptInviteForRequest, revokeMemberForRequest, type MemberRuntime } from './members-request.js';

function identityDeps(opts: { userId?: string | null; email?: string; verified?: boolean } = {}): VerifiedIdentityDeps {
  const { userId = 'clerk_1', email = 'me@example.com', verified = true } = opts;
  return {
    getUserId: () => Promise.resolve(userId),
    getBackendUser: () =>
      Promise.resolve({ id: 'clerk_1', primaryEmailAddressId: 'e1', emailAddresses: [{ id: 'e1', emailAddress: email, verification: { status: verified ? 'verified' : 'unverified' } }], firstName: null, lastName: null }),
  };
}

function fakeRuntime(overrides: Partial<MemberRuntime> = {}): MemberRuntime {
  return {
    resolveInternalUser: () => Promise.resolve({ status: 'active', userId: 'u1' }),
    ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_1', created: false }),
    inviteMember: () => Promise.resolve({ status: 'ok', membershipId: 'm1', token: 'tok', role: 'viewer' }),
    acceptInvite: () => Promise.resolve({ status: 'ok', membershipId: 'm1', accountId: 'acc_2', role: 'viewer' }),
    revokeMember: () => Promise.resolve({ status: 'ok' }),
    listMembers: () => Promise.resolve({ status: 'ok', members: [] }),
    ...overrides,
  };
}

describe('listMembersForRequest', () => {
  test('unauthenticated → unauthenticated', async () => {
    const r = await listMembersForRequest({ identity: identityDeps({ userId: null }), runtime: fakeRuntime() });
    expect(r.status).toBe('unauthenticated');
  });
  test('a deleted internal identity → forbidden', async () => {
    const r = await listMembersForRequest({ identity: identityDeps(), runtime: fakeRuntime({ resolveInternalUser: () => Promise.resolve({ status: 'deleted' }) }) });
    expect(r.status).toBe('forbidden');
  });
  test('active member → members list', async () => {
    const r = await listMembersForRequest({ identity: identityDeps(), runtime: fakeRuntime({ listMembers: () => Promise.resolve({ status: 'ok', members: [{ membershipId: 'm1', role: 'owner', status: 'active', memberUserId: 'u1', invitedEmail: null, createdAt: '2026-01-01T00:00:00.000Z' }] }) }) });
    expect(r.status).toBe('members');
  });
});

describe('inviteMemberForRequest', () => {
  test('invites against the CALLER\'s own account and returns the token once', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_mine', created: false }),
      inviteMember: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'ok', membershipId: 'm9', token: 'secret-token', role: 'viewer' });
      },
    });
    const r = await inviteMemberForRequest({ invitedEmail: 'new@example.com', role: 'viewer' }, { identity: identityDeps(), runtime });
    expect(r).toEqual({ status: 'invited', membershipId: 'm9', role: 'viewer', inviteToken: 'secret-token' });
    // account + acting user resolved server-side; body cannot target another account.
    expect(calls).toEqual([{ accountId: 'acc_mine', actingUserId: 'u1', invitedEmail: 'new@example.com', role: 'viewer' }]);
  });
  test('a non-owner invite → forbidden', async () => {
    const r = await inviteMemberForRequest({ invitedEmail: 'x@example.com', role: 'viewer' }, { identity: identityDeps(), runtime: fakeRuntime({ inviteMember: () => Promise.resolve({ status: 'forbidden' }) }) });
    expect(r.status).toBe('forbidden');
  });
  test('a domain validation failure surfaces as validation', async () => {
    const r = await inviteMemberForRequest({ invitedEmail: 'bad', role: 'nope' }, { identity: identityDeps(), runtime: fakeRuntime({ inviteMember: () => Promise.resolve({ status: 'validation', error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'x', retryable: false } }) }) });
    expect(r.status).toBe('validation');
  });
});

describe('acceptInviteForRequest', () => {
  test('binds the accepting user\'s VERIFIED email and accepts', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      acceptInvite: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'ok', membershipId: 'm1', accountId: 'acc_other', role: 'viewer' });
      },
    });
    const r = await acceptInviteForRequest({ token: 'the-token' }, { identity: identityDeps({ email: 'invitee@example.com' }), runtime });
    expect(r).toEqual({ status: 'accepted', membershipId: 'm1', accountId: 'acc_other', role: 'viewer' });
    expect(calls).toEqual([{ token: 'the-token', acceptingUserId: 'u1', acceptingVerifiedEmail: 'invitee@example.com' }]);
  });
  test('a missing token is invalid_token without calling the runtime', async () => {
    let called = false;
    const r = await acceptInviteForRequest({ token: '' }, { identity: identityDeps(), runtime: fakeRuntime({ acceptInvite: () => { called = true; return Promise.resolve({ status: 'ok', membershipId: 'm', accountId: 'a', role: 'viewer' }); } }) });
    expect(r.status).toBe('invalid_token');
    expect(called).toBe(false);
  });
  test('an email mismatch is surfaced', async () => {
    const r = await acceptInviteForRequest({ token: 't' }, { identity: identityDeps(), runtime: fakeRuntime({ acceptInvite: () => Promise.resolve({ status: 'email_mismatch' }) }) });
    expect(r.status).toBe('email_mismatch');
  });
});

describe('revokeMemberForRequest', () => {
  test('owner revoke → revoked (scoped to the caller\'s account)', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({ ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_mine', created: false }), revokeMember: (p) => { calls.push(p); return Promise.resolve({ status: 'ok' }); } });
    const r = await revokeMemberForRequest('m_target', { identity: identityDeps(), runtime });
    expect(r.status).toBe('revoked');
    expect(calls).toEqual([{ accountId: 'acc_mine', actingUserId: 'u1', membershipId: 'm_target' }]);
  });
  test('last owner → last_owner; unknown → not_found; non-owner → forbidden', async () => {
    expect((await revokeMemberForRequest('m', { identity: identityDeps(), runtime: fakeRuntime({ revokeMember: () => Promise.resolve({ status: 'last_owner' }) }) })).status).toBe('last_owner');
    expect((await revokeMemberForRequest('m', { identity: identityDeps(), runtime: fakeRuntime({ revokeMember: () => Promise.resolve({ status: 'not_found' }) }) })).status).toBe('not_found');
    expect((await revokeMemberForRequest('m', { identity: identityDeps(), runtime: fakeRuntime({ revokeMember: () => Promise.resolve({ status: 'forbidden' }) }) })).status).toBe('forbidden');
  });
});
