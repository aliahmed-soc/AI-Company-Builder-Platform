// ACBP-P1-004 — real-PostgreSQL tests for the membership use cases (CDR-011). Trust-critical: proves the
// role matrix is enforced server-side, invites are email-bound + single-use, revocation is immediate,
// the last owner cannot be removed, and a non-member (incl. another account's owner) cannot read or
// mutate. Skips when ACBP_TEST_DATABASE_URL is unset; never mocked. Self-cleaning; runs no migrate-down.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { closeDatabase, migrateToLatest, type DatabaseClient, type NewUser } from '@acbp/database';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { inviteMember, acceptInvite, revokeMember, listMembers } from './membership-service.js';
import { hasTestDatabase, createSeedClient, createAppClient, enableAppLogin, disableAppLogin } from '../tenancy/rls-integration-support.js';

// The membership use cases run as the restricted `acbp_app` role (subject to FORCE RLS); schema + user
// fixtures are seeded via the superuser `seed` client. Proving the role matrix / isolation under `app` is
// the end-to-end RLS proof (ACBP-P1-006).
const NOW = () => new Date().toISOString();
let seq = 0;
async function seedUser(seed: DatabaseClient, email: string, verified = true): Promise<string> {
  seq += 1;
  const values: NewUser = { provider: 'clerk', provider_instance_id: 'ins_a', provider_user_id: `user_${seq}`, primary_email: email, email_verified: verified, provider_updated_at: NOW() };
  const row = await seed.kysely.insertInto('users').values(values).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

describe.skipIf(!hasTestDatabase)('membership use cases (real PostgreSQL, restricted role) — ACBP-P1-004/006', () => {
  let seed: DatabaseClient;
  let app: DatabaseClient;
  let ownerId: string;
  let accountId: string;

  beforeAll(async () => {
    seed = createSeedClient();
    for (const t of ['memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await seed.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(seed);
    expect(r.error).toBeUndefined();
    await enableAppLogin(seed);
    app = createAppClient();
  });
  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (seed) {
      await disableAppLogin(seed);
      for (const t of ['memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await seed.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(seed);
    }
  });
  beforeEach(async () => {
    await seed.kysely.deleteFrom('memberships').execute();
    await seed.kysely.deleteFrom('account_profiles').execute();
    await seed.kysely.deleteFrom('accounts').execute();
    await seed.kysely.deleteFrom('users').execute();
    ownerId = await seedUser(seed, 'owner@example.com');
    accountId = (await provisionPersonalAccount(app, ownerId)).accountId;
  });

  test('provisioning makes the founder an active owner member', async () => {
    const list = await listMembers(app, { accountId, actingUserId: ownerId });
    expect(list.status).toBe('ok');
    if (list.status === 'ok') {
      expect(list.members).toHaveLength(1);
      expect(list.members[0]).toMatchObject({ role: 'owner', status: 'active', memberUserId: ownerId });
    }
  });

  test('full invite → accept flow: an owner invites a viewer who accepts with a matching verified email', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'joiner@example.com', role: 'viewer' });
    expect(invite.status).toBe('ok');
    if (invite.status !== 'ok') return;

    const joinerId = await seedUser(seed, 'joiner@example.com');
    const accepted = await acceptInvite(app, { token: invite.token, acceptingUserId: joinerId });
    expect(accepted).toMatchObject({ status: 'ok', accountId, role: 'viewer' });

    const list = await listMembers(app, { accountId, actingUserId: ownerId });
    expect(list.status === 'ok' && list.members.length).toBe(2);
  });

  test('role matrix: a viewer cannot invite or revoke', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'viewer@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const viewerId = await seedUser(seed, 'viewer@example.com');
    await acceptInvite(app, { token: invite.token, acceptingUserId: viewerId });

    expect((await inviteMember(app, { accountId, actingUserId: viewerId, invitedEmail: 'x@example.com', role: 'viewer' })).status).toBe('forbidden');
    const ownerMembership = (await listMembers(app, { accountId, actingUserId: viewerId }));
    const ownerRow = ownerMembership.status === 'ok' ? ownerMembership.members.find((m) => m.role === 'owner') : undefined;
    expect((await revokeMember(app, { accountId, actingUserId: viewerId, membershipId: ownerRow?.membershipId ?? 'x' })).status).toBe('forbidden');
  });

  test('cross-account isolation: another account owner cannot list or revoke here', async () => {
    const outsiderId = await seedUser(seed, 'outsider@example.com');
    await provisionPersonalAccount(app, outsiderId); // their own account
    expect((await listMembers(app, { accountId, actingUserId: outsiderId })).status).toBe('forbidden');
    // Find our owner membership id and try to revoke it as the outsider.
    const list = await listMembers(app, { accountId, actingUserId: ownerId });
    const ownerRow = list.status === 'ok' ? list.members[0] : undefined;
    expect((await revokeMember(app, { accountId, actingUserId: outsiderId, membershipId: ownerRow?.membershipId ?? 'x' })).status).toBe('forbidden');
  });

  test('invite is email-bound: a user whose authoritative email differs is denied (no email param)', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'intended@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const attackerId = await seedUser(seed, 'attacker@example.com');
    // The accept function binds the email from users.primary_email; a mismatch denies (collapsed, no oracle).
    expect((await acceptInvite(app, { token: invite.token, acceptingUserId: attackerId })).status).toBe('invalid_or_used');
  });

  test('invite token is single-use', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'once@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const joinerId = await seedUser(seed, 'once@example.com');
    expect((await acceptInvite(app, { token: invite.token, acceptingUserId: joinerId })).status).toBe('ok');
    // Reusing the now-consumed token fails.
    const joiner2 = await seedUser(seed, 'once@example.com', true);
    expect((await acceptInvite(app, { token: invite.token, acceptingUserId: joiner2 })).status).toBe('invalid_or_used');
    expect((await acceptInvite(app, { token: 'totally-bogus', acceptingUserId: joinerId })).status).toBe('invalid_or_used');
  });

  test('revocation is immediate and the last owner cannot be removed', async () => {
    // Invite + accept a viewer, then revoke them.
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'temp@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const viewerId = await seedUser(seed, 'temp@example.com');
    const accepted = await acceptInvite(app, { token: invite.token, acceptingUserId: viewerId });
    if (accepted.status !== 'ok') throw new Error('setup accept failed');

    expect((await revokeMember(app, { accountId, actingUserId: ownerId, membershipId: accepted.membershipId })).status).toBe('ok');
    // The revoked viewer can no longer act as a member.
    expect((await listMembers(app, { accountId, actingUserId: viewerId })).status).toBe('forbidden');

    // The sole owner cannot revoke themselves.
    const list = await listMembers(app, { accountId, actingUserId: ownerId });
    const ownerRow = list.status === 'ok' ? list.members.find((m) => m.role === 'owner') : undefined;
    expect((await revokeMember(app, { accountId, actingUserId: ownerId, membershipId: ownerRow?.membershipId ?? 'x' })).status).toBe('last_owner');
  });

  test('revoking a pending invite cancels it: the token can no longer be accepted — preserved revoke semantics', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'pending-cancel@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    // Revoke the still-pending invite by its membership id (never an active member).
    expect((await revokeMember(app, { accountId, actingUserId: ownerId, membershipId: invite.membershipId })).status).toBe('ok');
    // The cancelled invite's token is no longer acceptable.
    const joinerId = await seedUser(seed, 'pending-cancel@example.com');
    expect((await acceptInvite(app, { token: invite.token, acceptingUserId: joinerId })).status).toBe('invalid_or_used');
  });

  test('last-owner invariant holds under concurrency: two parallel revokes of DIFFERENT owners keep >=1 owner — CDR-011', async () => {
    // Promote the account to TWO active owners (founder + an invited/accepted owner).
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'owner2@example.com', role: 'owner' });
    if (invite.status !== 'ok') throw new Error('setup owner invite failed');
    const owner2Id = await seedUser(seed, 'owner2@example.com');
    const accepted = await acceptInvite(app, { token: invite.token, acceptingUserId: owner2Id });
    if (accepted.status !== 'ok') throw new Error('setup owner accept failed');

    const list = await listMembers(app, { accountId, actingUserId: ownerId });
    const owner1 = list.status === 'ok' ? list.members.find((m) => m.memberUserId === ownerId && m.role === 'owner' && m.status === 'active') : undefined;
    if (owner1 === undefined) throw new Error('setup: founder owner membership not found');

    // Two owners revoke EACH OTHER at the same instant. Each call opens its own transaction on a distinct
    // pooled connection, so the revocations race for real. Without the atomic owner-lock guard, both would
    // observe "2 owners", both pass, and both flip — leaving ZERO active owners (the CDR-011 violation).
    const [r1, r2] = await Promise.all([
      revokeMember(app, { accountId, actingUserId: ownerId, membershipId: accepted.membershipId }),
      revokeMember(app, { accountId, actingUserId: owner2Id, membershipId: owner1.membershipId }),
    ]);

    // At most one revocation may succeed; the other must be refused (last_owner) or lose authorization
    // (its own actor row was concurrently revoked) — never both 'ok'.
    expect([r1.status, r2.status].filter((s) => s === 'ok').length).toBeLessThanOrEqual(1);

    // The invariant, asserted against authoritative DB state via the superuser seed client.
    const remaining = await seed.kysely
      .selectFrom('memberships')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('account_id', '=', accountId)
      .where('role', '=', 'owner')
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();
    expect(Number(remaining.n)).toBeGreaterThanOrEqual(1);
  });

  test('member:read_invited_email — an owner sees pending-invite emails; a viewer gets them redacted — ACBP-P1-007', async () => {
    // Owner creates a pending invite (an unaccepted row carrying an invited_email).
    const pending = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'pending@example.com', role: 'viewer' });
    if (pending.status !== 'ok') throw new Error('setup pending invite failed');

    // Add a viewer member who can list.
    const vInvite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'viewer@example.com', role: 'viewer' });
    if (vInvite.status !== 'ok') throw new Error('setup viewer invite failed');
    const viewerId = await seedUser(seed, 'viewer@example.com');
    if ((await acceptInvite(app, { token: vInvite.token, acceptingUserId: viewerId })).status !== 'ok') throw new Error('setup viewer accept failed');

    // Owner sees the pending invite's email; the viewer gets it redacted (member:read_invited_email → owner).
    const asOwner = await listMembers(app, { accountId, actingUserId: ownerId });
    const asViewer = await listMembers(app, { accountId, actingUserId: viewerId });
    const ownerPendingRow = asOwner.status === 'ok' ? asOwner.members.find((m) => m.status === 'invited' && m.membershipId === pending.membershipId) : undefined;
    const viewerPendingRow = asViewer.status === 'ok' ? asViewer.members.find((m) => m.status === 'invited' && m.membershipId === pending.membershipId) : undefined;
    expect(ownerPendingRow?.invitedEmail).toBe('pending@example.com');
    expect(viewerPendingRow?.invitedEmail).toBeNull();
  });

  test('a role change is reflected on the very next authorization decision (no caching) — ACBP-P1-007', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'promote@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const memberId = await seedUser(seed, 'promote@example.com');
    const accepted = await acceptInvite(app, { token: invite.token, acceptingUserId: memberId });
    if (accepted.status !== 'ok') throw new Error('setup accept failed');

    // As a viewer, inviting is denied by the central authz.check (role loaded from the membership row).
    expect((await inviteMember(app, { accountId, actingUserId: memberId, invitedEmail: 'a@example.com', role: 'viewer' })).status).toBe('forbidden');

    // Promote the member to owner directly in the database (seed/superuser) between two requests.
    await seed.kysely.updateTable('memberships').set({ role: 'owner' }).where('id', '=', accepted.membershipId).execute();

    // The VERY NEXT call sees the new role — the decision is not cached across requests.
    expect((await inviteMember(app, { accountId, actingUserId: memberId, invitedEmail: 'a@example.com', role: 'viewer' })).status).toBe('ok');
  });

  test('a duplicate outstanding invite to the same email is a conflict', async () => {
    expect((await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'dup@example.com', role: 'viewer' })).status).toBe('ok');
    expect((await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'dup@example.com', role: 'viewer' })).status).toBe('conflict');
  });
});
