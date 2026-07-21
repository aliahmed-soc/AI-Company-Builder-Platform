// ACBP-P1-004 — unit tests for membership use cases (fake store; no database).
import { describe, test, expect } from 'vitest';
import { createTestLogger } from '@acbp/observability';
import {
  inviteMemberWithStore,
  revokeMemberWithStore,
  listMembersWithStore,
  type MembershipStore,
  type MemberView,
} from './membership-service.js';
import { hashInviteToken } from './invite-token.js';

// Invite acceptance is a pre-context bootstrap operation handled atomically by the `acbp_accept_invite`
// SECURITY DEFINER function (ACBP-P1-006; CDR-013) — it is covered by the real-PG bootstrap suite, not
// these store-based unit tests.
function makeStore(overrides: Partial<MembershipStore> = {}): MembershipStore {
  return {
    resolveActiveRole: () => Promise.resolve(null),
    findPendingByAccountAndEmail: () => Promise.resolve(undefined),
    insertInvite: () => Promise.resolve({ id: 'm_new' }),
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

  test('only owners see pending-invite emails; viewers get them redacted', async () => {
    const pending: MemberView[] = [{ membershipId: 'inv1', role: 'viewer', status: 'invited', memberUserId: null, invitedEmail: 'pending@example.com', createdAt: '2026-01-01T00:00:00.000Z' }];
    const asOwner = await listMembersWithStore(makeStore({ resolveActiveRole: () => Promise.resolve('owner'), listMembers: () => Promise.resolve(pending) }), { accountId: 'a', actingUserId: 'o' });
    expect(asOwner.status === 'ok' && asOwner.members[0]?.invitedEmail).toBe('pending@example.com');
    const asViewer = await listMembersWithStore(makeStore({ resolveActiveRole: () => Promise.resolve('viewer'), listMembers: () => Promise.resolve(pending) }), { accountId: 'a', actingUserId: 'v' });
    expect(asViewer.status === 'ok' && asViewer.members[0]?.invitedEmail).toBeNull();
  });
});
