// ACBP-P1-004 — unit tests for the authenticated members request use cases (injected deps; no Clerk/DB).
import { describe, test, expect } from 'vitest';
import type { VerifiedIdentityDeps } from '../auth/verified-identity.js';
import { listMembersForRequest, inviteMemberForRequest, acceptInviteForRequest, revokeMemberForRequest, type MemberRuntime } from './members-request.js';

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

function fakeRuntime(overrides: Partial<MemberRuntime> = {}): MemberRuntime {
  return {
    // ACBP-P7-013: REQUIRED on the runtime, so a fake cannot be admitted by omission (CDR-082 section 2).
    checkRequestLimit: () => Promise.resolve({ kind: 'allowed' } as const),
    resolveInternalUser: () => Promise.resolve({ status: 'active', userId: 'u1' }),
    ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_1', created: false }),
    inviteMember: () => Promise.resolve({ status: 'ok', membershipId: 'm1', token: 'tok', role: 'viewer' }),
    acceptInvite: () => Promise.resolve({ status: 'ok', membershipId: 'm1', accountId: 'acc_2', role: 'viewer' }),
    revokeMember: () => Promise.resolve({ status: 'ok', changed: true }),
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
  test('passes only the token + server-verified user id (email is bound server-side, not a caller value)', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      acceptInvite: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'ok', membershipId: 'm1', accountId: 'acc_other', role: 'viewer' });
      },
    });
    const r = await acceptInviteForRequest({ token: 'the-token' }, { identity: identityDeps({ email: 'invitee@example.com' }), runtime });
    expect(r).toEqual({ status: 'accepted', membershipId: 'm1', accountId: 'acc_other', role: 'viewer' });
    // No acceptingVerifiedEmail is forwarded — the bootstrap function derives it from users.
    expect(calls).toEqual([{ token: 'the-token', acceptingUserId: 'u1' }]);
  });
  test('a missing token is invalid_token without calling the runtime', async () => {
    let called = false;
    const r = await acceptInviteForRequest({ token: '' }, { identity: identityDeps(), runtime: fakeRuntime({ acceptInvite: () => { called = true; return Promise.resolve({ status: 'ok', membershipId: 'm', accountId: 'a', role: 'viewer' }); } }) });
    expect(r.status).toBe('invalid_token');
    expect(called).toBe(false);
  });
  test('any acceptance failure collapses to a safe invalid_token (no email/state oracle)', async () => {
    const r = await acceptInviteForRequest({ token: 't' }, { identity: identityDeps(), runtime: fakeRuntime({ acceptInvite: () => Promise.resolve({ status: 'invalid_or_used' }) }) });
    expect(r.status).toBe('invalid_token');
  });
});

// ACBP-P1-007 — the acting authority is ALWAYS the server-verified identity + the caller's own account
// resolved server-side; NO role/account/actor supplied by the request body, a header, or a Clerk claim can
// grant or elevate access. The core authz.check (modeled by the runtime here) is the sole authority.
describe('ACBP-P1-007 — no request-supplied authority (forged-claim safety)', () => {
  test('acting user + account are server-resolved; a forged body role is only the INVITEE grant, never the caller\'s authority', async () => {
    const calls: Array<{ accountId: string; actingUserId: string; invitedEmail: unknown; role: unknown }> = [];
    const runtime = fakeRuntime({
      resolveInternalUser: () => Promise.resolve({ status: 'active', userId: 'server_user' }),
      ensurePersonalAccount: () => Promise.resolve({ accountId: 'server_acc', created: false }),
      inviteMember: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'forbidden' });
      },
    });
    // The body asks to grant the invitee 'owner' — that is a GRANT to the invitee, not the caller's authority.
    const r = await inviteMemberForRequest({ invitedEmail: 'x@example.com', role: 'owner' }, { identity: identityDeps(), runtime });
    expect(r.status).toBe('forbidden'); // the membership-derived authz decision governs, not the request
    // accountId + actingUserId came from SERVER resolution; the request cannot inject them.
    expect(calls).toEqual([{ accountId: 'server_acc', actingUserId: 'server_user', invitedEmail: 'x@example.com', role: 'owner' }]);
  });

  test('a non-owner caller cannot self-elevate: a core forbidden is honored regardless of request content', async () => {
    const r = await inviteMemberForRequest({ invitedEmail: 'y@example.com', role: 'viewer' }, { identity: identityDeps(), runtime: fakeRuntime({ inviteMember: () => Promise.resolve({ status: 'forbidden' }) }) });
    expect(r.status).toBe('forbidden');
  });

  test('revoke authority is server-resolved: the caller cannot target another account (accountId is never request-supplied)', async () => {
    const calls: Array<{ accountId: string; actingUserId: string; membershipId: string }> = [];
    const runtime = fakeRuntime({
      resolveInternalUser: () => Promise.resolve({ status: 'active', userId: 'server_user' }),
      ensurePersonalAccount: () => Promise.resolve({ accountId: 'server_acc', created: false }),
      revokeMember: (p) => {
        calls.push(p);
        return Promise.resolve({ status: 'forbidden' });
      },
    });
    const r = await revokeMemberForRequest('m_target', { identity: identityDeps(), runtime });
    expect(r.status).toBe('forbidden');
    expect(calls).toEqual([{ accountId: 'server_acc', actingUserId: 'server_user', membershipId: 'm_target' }]);
  });
});

// ACBP-P1-007 — a negative test per privileged endpoint: an unauthorized principal (unauthenticated,
// unverified email, deleted identity, or a role the core authz.check denies) is refused on every endpoint.
describe('ACBP-P1-007 — endpoint×principal negative matrix (request layer)', () => {
  const forbiddenRuntime = () => fakeRuntime({ inviteMember: () => Promise.resolve({ status: 'forbidden' }), revokeMember: () => Promise.resolve({ status: 'forbidden' }), listMembers: () => Promise.resolve({ status: 'forbidden' }) });

  test('GET /members (list): unauthenticated→unauthenticated, unverified→email_unverified, non-member→forbidden', async () => {
    expect((await listMembersForRequest({ identity: identityDeps({ userId: null }), runtime: fakeRuntime() })).status).toBe('unauthenticated');
    expect((await listMembersForRequest({ identity: identityDeps({ verified: false }), runtime: fakeRuntime() })).status).toBe('email_unverified');
    expect((await listMembersForRequest({ identity: identityDeps(), runtime: forbiddenRuntime() })).status).toBe('forbidden');
  });

  test('POST /members (invite): unauthenticated→unauthenticated, unverified→email_unverified, non-owner→forbidden', async () => {
    const body = { invitedEmail: 'z@example.com', role: 'viewer' };
    expect((await inviteMemberForRequest(body, { identity: identityDeps({ userId: null }), runtime: fakeRuntime() })).status).toBe('unauthenticated');
    expect((await inviteMemberForRequest(body, { identity: identityDeps({ verified: false }), runtime: fakeRuntime() })).status).toBe('email_unverified');
    expect((await inviteMemberForRequest(body, { identity: identityDeps(), runtime: forbiddenRuntime() })).status).toBe('forbidden');
  });

  test('DELETE /members/[id] (revoke): unauthenticated→unauthenticated, unverified→email_unverified, non-owner→forbidden', async () => {
    expect((await revokeMemberForRequest('m', { identity: identityDeps({ userId: null }), runtime: fakeRuntime() })).status).toBe('unauthenticated');
    expect((await revokeMemberForRequest('m', { identity: identityDeps({ verified: false }), runtime: fakeRuntime() })).status).toBe('email_unverified');
    expect((await revokeMemberForRequest('m', { identity: identityDeps(), runtime: forbiddenRuntime() })).status).toBe('forbidden');
  });
});

describe('revokeMemberForRequest', () => {
  test('owner revoke → revoked (scoped to the caller\'s account)', async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({ ensurePersonalAccount: () => Promise.resolve({ accountId: 'acc_mine', created: false }), revokeMember: (p) => { calls.push(p); return Promise.resolve({ status: 'ok', changed: true }); } });
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
