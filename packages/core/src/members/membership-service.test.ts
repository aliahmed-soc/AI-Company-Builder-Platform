// ACBP-P1-004 — unit tests for membership use cases (fake store; no database).
import { describe, test, expect } from 'vitest';
import { createTestLogger } from '@acbp/observability';
import {
  inviteMemberWithStore,
  acceptInviteWithStore,
  revokeMemberWithStore,
  listMembersWithStore,
  type MembershipStore,
  type MemberView,
} from './membership-service.js';
import { hashInviteToken } from './invite-token.js';

function makeStore(overrides: Partial<MembershipStore> = {}): MembershipStore {
  return {
    resolveActiveRole: () => Promise.resolve(null),
    findPendingByAccountAndEmail: () => Promise.resolve(undefined),
    insertInvite: () => Promise.resolve({ id: 'm_new' }),
    findPendingByTokenHash: () => Promise.resolve(undefined),
    activateInvite: () => Promise.resolve(),
    findInAccount: () => Promise.resolve(undefined),
    countActiveOwners: () => Promise.resolve(1),
    revokeMembership: () => Promise.resolve(),
    listMembers: () => Promise.resolve([]),
    ...overrides,
  };
}
const fixedToken = () => ({ token: 'raw-token', tokenHash: hashInviteToken('raw-token') });

describe('inviteMemberWithStore', () => {
  test('a viewer cannot invite (forbidden) — role comes from the store, not the request', async () => {
    const store = makeStore({ resolveActiveRole: () => Promise.resolve('viewer') });
    const r = await inviteMemberWithStore(store, { accountId: 'acc_1', actingUserId: 'u1', invitedEmail: 'x@example.com', role: 'viewer' });
    expect(r.status).toBe('forbidden');
  });

  test('an owner invite returns the raw token once and audits (no PII in the event)', async () => {
    const inserted: unknown[] = [];
    const store = makeStore({
      resolveActiveRole: () => Promise.resolve('owner'),
      insertInvite: (v) => {
        inserted.push(v);
        return Promise.resolve({ id: 'm_1' });
      },
    });
    const { logger, records } = createTestLogger({ component: 'members' });
    const r = await inviteMemberWithStore(store, { accountId: 'acc_1', actingUserId: 'owner', invitedEmail: '  New@Example.com ', role: 'viewer' }, { logger, generateToken: fixedToken });
    expect(r).toEqual({ status: 'ok', membershipId: 'm_1', token: 'raw-token', role: 'viewer' });
    // Email normalized; token stored as HASH only.
    expect(inserted).toEqual([{ accountId: 'acc_1', invitedEmail: 'new@example.com', role: 'viewer', tokenHash: hashInviteToken('raw-token'), invitedByUserId: 'owner' }]);
    const ev = records.filter((x) => x.event === 'membership.invited');
    expect(ev).toHaveLength(1);
    expect(ev[0]?.metadata).toEqual({ accountId: 'acc_1', membershipId: 'm_1', role: 'viewer' });
    expect(JSON.stringify(ev[0])).not.toContain('example.com'); // no email in the audit event
    expect(JSON.stringify(ev[0])).not.toContain('raw-token'); // no token in the audit event
  });

  test('invalid email or role is rejected with a safe validation envelope', async () => {
    const store = makeStore({ resolveActiveRole: () => Promise.resolve('owner') });
    const badEmail = await inviteMemberWithStore(store, { accountId: 'a', actingUserId: 'o', invitedEmail: 'not-an-email', role: 'viewer' });
    expect(badEmail.status).toBe('validation');
    const badRole = await inviteMemberWithStore(store, { accountId: 'a', actingUserId: 'o', invitedEmail: 'x@example.com', role: 'admin' });
    expect(badRole.status).toBe('validation');
  });

  test('a duplicate outstanding invite is a conflict', async () => {
    const store = makeStore({ resolveActiveRole: () => Promise.resolve('owner'), findPendingByAccountAndEmail: () => Promise.resolve({ id: 'm_existing' }) });
    const r = await inviteMemberWithStore(store, { accountId: 'a', actingUserId: 'o', invitedEmail: 'x@example.com', role: 'viewer' }, { generateToken: fixedToken });
    expect(r.status).toBe('conflict');
  });
});

describe('acceptInviteWithStore', () => {
  const invite = { id: 'm_1', accountId: 'acc_1', invitedEmail: 'joiner@example.com', role: 'viewer' as const };

  test('an unknown/used token is invalid_or_used', async () => {
    const r = await acceptInviteWithStore(makeStore(), { token: 'nope', acceptingUserId: 'u2', acceptingVerifiedEmail: 'joiner@example.com' });
    expect(r.status).toBe('invalid_or_used');
  });

  test('a mismatched verified email is rejected (a leaked token cannot be used by another person)', async () => {
    const store = makeStore({ findPendingByTokenHash: () => Promise.resolve(invite) });
    const r = await acceptInviteWithStore(store, { token: 'raw-token', acceptingUserId: 'u2', acceptingVerifiedEmail: 'someone-else@example.com' });
    expect(r.status).toBe('email_mismatch');
  });

  test('already-active member is not re-added', async () => {
    const store = makeStore({ findPendingByTokenHash: () => Promise.resolve(invite), resolveActiveRole: () => Promise.resolve('viewer') });
    const r = await acceptInviteWithStore(store, { token: 'raw-token', acceptingUserId: 'u2', acceptingVerifiedEmail: 'joiner@example.com' });
    expect(r.status).toBe('already_member');
  });

  test('a matching verified email activates the membership and audits', async () => {
    const activated: string[] = [];
    const store = makeStore({
      findPendingByTokenHash: () => Promise.resolve(invite),
      resolveActiveRole: () => Promise.resolve(null),
      activateInvite: (id, uid) => {
        activated.push(`${id}:${uid}`);
        return Promise.resolve();
      },
    });
    const { logger, records } = createTestLogger({ component: 'members' });
    const r = await acceptInviteWithStore(store, { token: 'raw-token', acceptingUserId: 'u2', acceptingVerifiedEmail: 'Joiner@Example.com' }, { logger });
    expect(r).toEqual({ status: 'ok', membershipId: 'm_1', accountId: 'acc_1', role: 'viewer' });
    expect(activated).toEqual(['m_1:u2']);
    expect(records.filter((x) => x.event === 'membership.accepted')).toHaveLength(1);
  });
});

describe('revokeMemberWithStore', () => {
  test('a viewer cannot revoke (forbidden)', async () => {
    const store = makeStore({ resolveActiveRole: () => Promise.resolve('viewer') });
    expect((await revokeMemberWithStore(store, { accountId: 'a', actingUserId: 'u', membershipId: 'm' })).status).toBe('forbidden');
  });

  test('an unknown membership is not_found', async () => {
    const store = makeStore({ resolveActiveRole: () => Promise.resolve('owner'), findInAccount: () => Promise.resolve(undefined) });
    expect((await revokeMemberWithStore(store, { accountId: 'a', actingUserId: 'o', membershipId: 'm' })).status).toBe('not_found');
  });

  test('the last active owner cannot be revoked', async () => {
    const store = makeStore({
      resolveActiveRole: () => Promise.resolve('owner'),
      findInAccount: () => Promise.resolve({ id: 'm_owner', role: 'owner', status: 'active' }),
      countActiveOwners: () => Promise.resolve(1),
    });
    expect((await revokeMemberWithStore(store, { accountId: 'a', actingUserId: 'o', membershipId: 'm_owner' })).status).toBe('last_owner');
  });

  test('an owner can revoke a viewer (immediate) and it audits', async () => {
    const revoked: string[] = [];
    const store = makeStore({
      resolveActiveRole: () => Promise.resolve('owner'),
      findInAccount: () => Promise.resolve({ id: 'm_v', role: 'viewer', status: 'active' }),
      revokeMembership: (id) => {
        revoked.push(id);
        return Promise.resolve();
      },
    });
    const { logger, records } = createTestLogger({ component: 'members' });
    const r = await revokeMemberWithStore(store, { accountId: 'a', actingUserId: 'o', membershipId: 'm_v' }, { logger });
    expect(r.status).toBe('ok');
    expect(revoked).toEqual(['m_v']);
    expect(records.filter((x) => x.event === 'membership.revoked')).toHaveLength(1);
  });

  test('revoking an already-revoked membership is an idempotent no-op', async () => {
    const revoked: string[] = [];
    const store = makeStore({
      resolveActiveRole: () => Promise.resolve('owner'),
      findInAccount: () => Promise.resolve({ id: 'm_v', role: 'viewer', status: 'revoked' }),
      revokeMembership: (id) => {
        revoked.push(id);
        return Promise.resolve();
      },
    });
    expect((await revokeMemberWithStore(store, { accountId: 'a', actingUserId: 'o', membershipId: 'm_v' })).status).toBe('ok');
    expect(revoked).toEqual([]); // no second revoke
  });
});

describe('listMembersWithStore', () => {
  const members: MemberView[] = [{ membershipId: 'm1', role: 'owner', status: 'active', memberUserId: 'u1', invitedEmail: null, createdAt: '2026-01-01T00:00:00.000Z' }];

  test('a non-member cannot list (forbidden)', async () => {
    expect((await listMembersWithStore(makeStore({ resolveActiveRole: () => Promise.resolve(null) }), { accountId: 'a', actingUserId: 'stranger' })).status).toBe('forbidden');
  });

  test('a viewer (member) may list', async () => {
    const store = makeStore({ resolveActiveRole: () => Promise.resolve('viewer'), listMembers: () => Promise.resolve(members) });
    const r = await listMembersWithStore(store, { accountId: 'a', actingUserId: 'u2' });
    expect(r).toEqual({ status: 'ok', members });
  });
});
