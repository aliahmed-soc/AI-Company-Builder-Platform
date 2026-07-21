// ACBP-P1-004 — unit tests for membership use cases (fake store; no database).
import { describe, test, expect } from 'vitest';
import { createTestLogger } from '@acbp/observability';
import {
  inviteMemberWithStore,
  revokeMemberWithStore,
  listMembersWithStore,
  type MembershipStore,
  type MemberView,
  type MembershipStatus,
} from './membership-service.js';
import type { MemberRole } from './roles.js';
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
    revokeActiveMembership: () => Promise.resolve('revoked'),
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

  test('a forbidden invite is audited via the central authz.denied event (non-PII) — ACBP-P1-007', async () => {
    const store = makeStore({ resolveActiveRole: () => Promise.resolve('viewer') });
    const { logger, records } = createTestLogger({ component: 'members' });
    const r = await inviteMemberWithStore(store, { accountId: 'acc_1', actingUserId: 'u_v', invitedEmail: 'x@example.com', role: 'viewer' }, { logger });
    expect(r.status).toBe('forbidden');
    const ev = records.filter((x) => x.event === 'authz.denied');
    expect(ev).toHaveLength(1);
    expect(ev[0]?.metadata).toEqual({ action: 'member:invite', reason: 'insufficient_role', accountId: 'acc_1', actorId: 'u_v' });
    expect(JSON.stringify(ev[0])).not.toContain('example.com'); // no email in the denial audit
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

  test('the last active owner cannot be revoked (the store refuses atomically)', async () => {
    const store = makeStore({
      resolveActiveRole: () => Promise.resolve('owner'),
      findInAccount: () => Promise.resolve({ id: 'm_owner', role: 'owner', status: 'active' }),
      revokeActiveMembership: () => Promise.resolve('last_owner'),
    });
    expect((await revokeMemberWithStore(store, { accountId: 'a', actingUserId: 'o', membershipId: 'm_owner' })).status).toBe('last_owner');
  });

  test('an owner can revoke a viewer (immediate) and it audits', async () => {
    const revoked: Array<[string, string]> = [];
    const store = makeStore({
      resolveActiveRole: () => Promise.resolve('owner'),
      findInAccount: () => Promise.resolve({ id: 'm_v', role: 'viewer', status: 'active' }),
      revokeActiveMembership: (accountId, id) => {
        revoked.push([accountId, id]);
        return Promise.resolve('revoked');
      },
    });
    const { logger, records } = createTestLogger({ component: 'members' });
    const r = await revokeMemberWithStore(store, { accountId: 'a', actingUserId: 'o', membershipId: 'm_v' }, { logger });
    expect(r).toMatchObject({ status: 'ok', changed: true, membershipId: 'm_v', role: 'viewer' });
    expect(revoked).toEqual([['a', 'm_v']]);
    expect(records.filter((x) => x.event === 'membership.revoked')).toHaveLength(1);
  });

  test('revoking an already-revoked membership is an idempotent no-op (store not touched)', async () => {
    const revoked: string[] = [];
    const store = makeStore({
      resolveActiveRole: () => Promise.resolve('owner'),
      findInAccount: () => Promise.resolve({ id: 'm_v', role: 'viewer', status: 'revoked' }),
      revokeActiveMembership: (_accountId, id) => {
        revoked.push(id);
        return Promise.resolve('noop');
      },
    });
    const r = await revokeMemberWithStore(store, { accountId: 'a', actingUserId: 'o', membershipId: 'm_v' });
    expect(r).toMatchObject({ status: 'ok', changed: false });
    expect(revoked).toEqual([]); // short-circuited before the store; no revoke attempted
  });

  test('a revoke that loses the race (noop) succeeds as an idempotent no-op and does NOT re-audit', async () => {
    const store = makeStore({
      resolveActiveRole: () => Promise.resolve('owner'),
      findInAccount: () => Promise.resolve({ id: 'm_v', role: 'viewer', status: 'active' }),
      revokeActiveMembership: () => Promise.resolve('noop'),
    });
    const { logger, records } = createTestLogger({ component: 'members' });
    const r = await revokeMemberWithStore(store, { accountId: 'a', actingUserId: 'o', membershipId: 'm_v' }, { logger });
    expect(r).toMatchObject({ status: 'ok', changed: false });
    expect(records.filter((x) => x.event === 'membership.revoked')).toHaveLength(0); // only the actual flip audits
  });

  // CDR-011 (last-owner invariant), concurrency. Because the service delegates the owner-count decision AND
  // the revoke to ONE store call (revokeActiveMembership), two concurrent revocations of DIFFERENT active
  // owners cannot both drain the account: the fake models the store's atomicity by reading the count and
  // mutating within a single synchronous body (no await between them), exactly as the real repository's
  // `FOR UPDATE` lock does. A read-then-act service (two awaits) would interleave here and reach zero owners.
  // The real-PostgreSQL row-lock proof is in members.integration.test.ts.
  test('concurrent revokes of two different active owners never leave the account with zero owners', async () => {
    const owners = new Map<string, { role: MemberRole; status: MembershipStatus }>([
      ['m_o1', { role: 'owner', status: 'active' }],
      ['m_o2', { role: 'owner', status: 'active' }],
    ]);
    const activeOwnerCount = () => [...owners.values()].filter((o) => o.role === 'owner' && o.status === 'active').length;
    const store = makeStore({
      resolveActiveRole: () => Promise.resolve('owner'),
      findInAccount: (_accountId, id) => Promise.resolve(owners.has(id) ? { id, role: owners.get(id)!.role, status: owners.get(id)!.status } : undefined),
      // Atomic (single synchronous decision + flip), like the repository's locked owner-set operation.
      revokeActiveMembership: (_accountId, id) => {
        const m = owners.get(id);
        if (m === undefined || m.status !== 'active') return Promise.resolve('noop');
        if (m.role === 'owner' && activeOwnerCount() <= 1) return Promise.resolve('last_owner');
        m.status = 'revoked';
        return Promise.resolve('revoked');
      },
    });

    const [r1, r2] = await Promise.all([
      revokeMemberWithStore(store, { accountId: 'a', actingUserId: 'o1', membershipId: 'm_o1' }),
      revokeMemberWithStore(store, { accountId: 'a', actingUserId: 'o2', membershipId: 'm_o2' }),
    ]);

    expect(activeOwnerCount()).toBeGreaterThanOrEqual(1);
    // Exactly one revocation succeeds; the other is refused as last_owner.
    expect([r1.status, r2.status].filter((s) => s === 'ok')).toHaveLength(1);
    expect([r1.status, r2.status]).toContain('last_owner');
  });
});

describe('listMembersWithStore', () => {
  const members: MemberView[] = [{ membershipId: 'm1', role: 'owner', status: 'active', memberUserId: 'u1', invitedEmail: null, createdAt: '2026-01-01T00:00:00.000Z' }];

  test('a non-member cannot list (forbidden)', async () => {
    expect((await listMembersWithStore(makeStore({ resolveActiveRole: () => Promise.resolve(null) }), { accountId: 'a', actingUserId: 'stranger' })).status).toBe('forbidden');
  });

  test('a non-member list denial is audited via authz.denied (not_a_member) — ACBP-P1-007', async () => {
    const { logger, records } = createTestLogger({ component: 'members' });
    const r = await listMembersWithStore(makeStore({ resolveActiveRole: () => Promise.resolve(null) }), { accountId: 'a', actingUserId: 'stranger' }, { logger });
    expect(r.status).toBe('forbidden');
    const ev = records.filter((x) => x.event === 'authz.denied');
    expect(ev).toHaveLength(1);
    expect(ev[0]?.metadata).toEqual({ action: 'member:list', reason: 'not_a_member', accountId: 'a', actorId: 'stranger' });
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
